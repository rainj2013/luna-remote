use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use chrono::{Local, Utc};
use russh_sftp::{
    client::{SftpSession, error::Error as SftpError},
    protocol::StatusCode,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    commands::AppState,
    database::Database,
    models::{
        ArchiveFormat, AuthType, ConnectInput, DeploymentFile, DeploymentPreview,
        DeploymentProfile, DeploymentRun, DirectoryEntry, EntryKind, SessionStatus,
    },
    sessions::SessionManager,
};

pub struct DeploymentManager {
    db: Arc<Database>,
    sessions: Arc<SessionManager>,
    active: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
    pending: Mutex<HashMap<String, PendingRun>>,
    triggered: Mutex<HashSet<String>>,
}

struct PendingRun {
    profile: DeploymentProfile,
    session_id: String,
    own_session: bool,
    cancelled: Arc<AtomicBool>,
}

fn profiles(db: &Database) -> Vec<DeploymentProfile> {
    let mut items: Vec<DeploymentProfile> = db.get_setting("deploymentProfiles", Vec::new());
    for profile in &mut items {
        profile.shell_template = migrate_shell_template(&profile.shell_template);
    }
    items
}

fn migrate_shell_template(value: &str) -> String {
    [
        ("LUNA_REMOTE_PACKAGE_PATH", "LUNA_FILE_PATH"),
        ("LUNA_REMOTE_TARGET_DIR", "LUNA_TARGET_DIR"),
        ("LUNA_REMOTE_STAGING_DIR", "LUNA_TARGET_DIR"),
        ("LUNA_REMOTE_FILES_DIR", "LUNA_TARGET_DIR"),
    ]
    .into_iter()
    .fold(value.to_string(), |template, (old, new)| {
        template.replace(old, new)
    })
}

fn normal_relative(value: &str) -> Result<String, String> {
    let value = value.replace('\\', "/");
    if value == "." {
        return Ok(value);
    }
    if value.is_empty()
        || value.starts_with('/')
        || value.contains('\0')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
    {
        return Err(format!("无效的工作区相对路径：{value}"));
    }
    Ok(value)
}

fn remote_directory(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let value = if value.is_empty() { "/" } else { value };
    if !value.starts_with('/')
        || value.contains('\0')
        || value.contains('\n')
        || value.split('/').any(|part| part == "." || part == "..")
    {
        return Err("远端目标目录必须是无穿越的绝对路径".into());
    }
    Ok(value.into())
}

fn remote_join(directory: &str, relative: &str) -> String {
    format!("{}/{}", directory.trim_end_matches('/'), relative)
}

fn archive_name(profile: &DeploymentProfile, timestamp: &str) -> String {
    let name = Path::new(&profile.workspace)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("deployment")
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    let stem = name.trim().trim_end_matches('.');
    format!(
        "{}_{}.{}",
        if stem.is_empty() { "deployment" } else { stem },
        timestamp,
        profile.archive_format.extension()
    )
}

fn resolved_archive_name(
    profile: &DeploymentProfile,
    preview_name: Option<&str>,
) -> Result<Option<String>, String> {
    if !profile.archive_enabled {
        return Ok(None);
    }
    if let Some(name) = preview_name {
        let prefix = archive_name(profile, "");
        let extension = format!(".{}", profile.archive_format.extension());
        let prefix = prefix.strip_suffix(&extension).expect("archive extension");
        let timestamp = name
            .strip_prefix(prefix)
            .and_then(|value| value.strip_suffix(&extension));
        if let Some(timestamp) = timestamp {
            if timestamp.len() == 14
                && timestamp.bytes().all(|byte| byte.is_ascii_digit())
                && chrono::NaiveDateTime::parse_from_str(timestamp, "%Y%m%d%H%M%S").is_ok()
            {
                return Ok(Some(name.to_string()));
            }
        }
        return Err("预览的压缩包文件名已失效，请重新预览".into());
    }
    Ok(Some(archive_name(
        profile,
        &Local::now().format("%Y%m%d%H%M%S").to_string(),
    )))
}

fn output_file(
    profile: &DeploymentProfile,
    files: &[DeploymentFile],
    archive_file_name: Option<&str>,
) -> Option<(String, String)> {
    let relative = if profile.archive_enabled {
        archive_file_name?.to_string()
    } else if files.len() == 1 {
        files[0].relative_path.clone()
    } else {
        return None;
    };
    let name = relative.rsplit('/').next()?.to_string();
    Some((name, remote_join(&profile.remote_directory, &relative)))
}

fn validate_profile(profile: &DeploymentProfile) -> Result<(), String> {
    Uuid::parse_str(&profile.id).map_err(|_| "任务 ID 无效".to_string())?;
    remote_directory(&profile.remote_directory)?;
    Ok(())
}

fn selected_path(relative: &str, rules: &[String]) -> bool {
    rules
        .iter()
        .any(|rule| rule == "." || relative == rule || relative.starts_with(&format!("{rule}/")))
}

fn relative_from_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|e| e.to_string())?
        .components()
        .map(|part| {
            let value = part.as_os_str().to_str().ok_or("文件名必须是 UTF-8")?;
            if value.contains('\\') || value.contains('/') || value.contains(':') {
                return Err(format!("不支持的文件名：{value}"));
            }
            Ok(value.to_string())
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join("/"))
}

fn selected_files(profile: &DeploymentProfile) -> Result<Vec<(String, PathBuf)>, String> {
    let root = Path::new(&profile.workspace);
    if !root.is_absolute()
        || !root.is_dir()
        || fs::symlink_metadata(root)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("工作区必须是存在且非符号链接的绝对目录".into());
    }
    let included = profile
        .selection
        .included
        .iter()
        .map(|v| normal_relative(v))
        .collect::<Result<Vec<_>, _>>()?;
    let excluded = profile
        .selection
        .excluded
        .iter()
        .map(|v| normal_relative(v))
        .collect::<Result<Vec<_>, _>>()?;
    let mut output = BTreeMap::new();
    for rule in &included {
        if selected_path(rule, &excluded) {
            continue;
        }
        let path = if rule == "." {
            root.to_path_buf()
        } else {
            root.join(rule)
        };
        let mut check = root.to_path_buf();
        for part in path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .components()
        {
            check.push(part);
            if fs::symlink_metadata(&check)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err(format!("不支持符号链接：{}", check.display()));
            }
        }
        if !path.exists() {
            return Err(format!("选中路径不存在：{}", path.display()));
        }
        for entry in walkdir::WalkDir::new(&path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                relative_from_path(root, entry.path())
                    .map(|relative| relative.is_empty() || !selected_path(&relative, &excluded))
                    .unwrap_or(true)
            })
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let relative = relative_from_path(root, entry.path())?;
            if relative.is_empty() {
                continue;
            }
            if entry.file_type().is_symlink() {
                return Err(format!("不支持符号链接：{}", entry.path().display()));
            }
            if entry.file_type().is_file() {
                output.insert(relative, entry.path().to_path_buf());
            }
        }
    }
    Ok(output.into_iter().collect())
}

fn sha256_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

fn copy_snapshot(
    source: &Path,
    destination: &Path,
    cancelled: &AtomicBool,
) -> Result<DeploymentFile, String> {
    if fs::symlink_metadata(source)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err(format!("不支持符号链接：{}", source.display()));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut reader = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut writer = fs::File::create(destination).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    Ok(DeploymentFile {
        relative_path: String::new(),
        size,
        sha256: format!("{:x}", hash.finalize()),
    })
}

fn build_zip(
    snapshot: &Path,
    archive: &Path,
    files: &[DeploymentFile],
    cancelled: &AtomicBool,
) -> Result<u64, String> {
    let writer = fs::File::create(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(writer);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for file in files {
        if cancelled.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        zip.start_file(&file.relative_path, options)
            .map_err(|e| e.to_string())?;
        let mut reader =
            fs::File::open(snapshot.join(&file.relative_path)).map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            zip.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(fs::metadata(archive).map_err(|e| e.to_string())?.len())
}

struct CancellableReader<'a> {
    file: fs::File,
    cancelled: &'a AtomicBool,
}

impl Read for CancellableReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("已取消"));
        }
        self.file.read(buffer)
    }
}

fn build_tar_gz(
    snapshot: &Path,
    archive: &Path,
    files: &[DeploymentFile],
    cancelled: &AtomicBool,
) -> Result<u64, String> {
    let writer = fs::File::create(archive).map_err(|e| e.to_string())?;
    let gzip = flate2::write::GzEncoder::new(writer, flate2::Compression::default());
    let mut tar = tar::Builder::new(gzip);
    for file in files {
        if cancelled.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let source =
            fs::File::open(snapshot.join(&file.relative_path)).map_err(|e| e.to_string())?;
        let mut header = tar::Header::new_gnu();
        header.set_size(file.size);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(
            &mut header,
            &file.relative_path,
            CancellableReader {
                file: source,
                cancelled,
            },
        )
        .map_err(|e| {
            if cancelled.load(Ordering::Relaxed) {
                "已取消".into()
            } else {
                e.to_string()
            }
        })?;
    }
    tar.finish().map_err(|e| e.to_string())?;
    let gzip = tar.into_inner().map_err(|e| e.to_string())?;
    gzip.finish().map_err(|e| e.to_string())?;
    Ok(fs::metadata(archive).map_err(|e| e.to_string())?.len())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn shell_command(
    profile: &DeploymentProfile,
    files: &[DeploymentFile],
    archive_file_name: Option<&str>,
) -> String {
    let output = output_file(profile, files, archive_file_name);
    let file_name = output.as_ref().map_or("", |(name, _)| name.as_str());
    let file_path = output.as_ref().map_or("", |(_, path)| path.as_str());
    let assignments = [
        ("LUNA_TARGET_DIR", profile.remote_directory.as_str()),
        ("LUNA_FILE_NAME", file_name),
        ("LUNA_FILE_PATH", file_path),
    ]
    .into_iter()
    .map(|(key, value)| format!("{key}={}", shell_quote(value)))
    .collect::<Vec<_>>();
    format!(
        "{} {} -lc {}",
        assignments.join(" "),
        profile.shell.executable(),
        shell_quote(&profile.shell_template)
    )
}

fn command_failure(code: u32, output: &str) -> String {
    let detail = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect::<String>();
    if detail.is_empty() {
        format!("远端命令退出码 {code}")
    } else {
        format!("远端命令退出码 {code}：{detail}")
    }
}

async fn ensure_remote_directory(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let mut current = String::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        current.push('/');
        current.push_str(part);
        if sftp
            .try_exists(current.clone())
            .await
            .map_err(|e| e.to_string())?
        {
            let meta = sftp
                .symlink_metadata(current.clone())
                .await
                .map_err(|e| e.to_string())?;
            if !meta.is_dir() || meta.is_symlink() {
                return Err(format!("远端路径不是安全目录：{current}"));
            }
        } else {
            sftp.create_dir(current.clone())
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn upload(
    sftp: &SftpSession,
    source: &Path,
    target: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    ensure_remote_directory(sftp, target.rsplit_once('/').map(|v| v.0).unwrap_or("/")).await?;
    match sftp.symlink_metadata(target.to_string()).await {
        Ok(meta) if meta.is_symlink() || !meta.is_regular() => {
            return Err(format!("目标路径不是普通文件：{target}"));
        }
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {}
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let mut reader = tokio::fs::File::open(source)
        .await
        .map_err(|e| e.to_string())?;
    let mut writer = sftp
        .create(target.to_string())
        .await
        .map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let count = tokio::time::timeout(
            Duration::from_secs(60),
            tokio::io::AsyncReadExt::read(&mut reader, &mut buffer),
        )
        .await
        .map_err(|_| "读取文件超时".to_string())?
        .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        tokio::time::timeout(Duration::from_secs(60), writer.write_all(&buffer[..count]))
            .await
            .map_err(|_| "上传 60 秒没有进展".to_string())?
            .map_err(|e| e.to_string())?;
    }
    writer.shutdown().await.map_err(|e| e.to_string())
}

impl DeploymentManager {
    pub fn new(db: Arc<Database>, sessions: Arc<SessionManager>) -> Arc<Self> {
        Arc::new(Self {
            db,
            sessions,
            active: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            triggered: Mutex::new(HashSet::new()),
        })
    }
    pub fn list(&self, bookmark_id: &str) -> Vec<DeploymentProfile> {
        profiles(&self.db)
            .into_iter()
            .filter(|p| p.bookmark_id == bookmark_id)
            .collect()
    }
    pub fn get(&self, id: &str) -> Result<DeploymentProfile, String> {
        profiles(&self.db)
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("部署任务不存在".into())
    }
    pub fn save(&self, mut profile: DeploymentProfile) -> Result<DeploymentProfile, String> {
        if self.db.get_bookmark(&profile.bookmark_id)?.is_none() {
            return Err("连接不存在".into());
        }
        if profile.id.is_empty() {
            profile.id = Uuid::new_v4().to_string();
        }
        Uuid::parse_str(&profile.id).map_err(|_| "任务 ID 无效".to_string())?;
        profile.name = profile.name.trim().to_string();
        profile.workspace = profile.workspace.trim().to_string();
        profile.remote_directory = remote_directory(&profile.remote_directory)?;
        profile.shell_template = migrate_shell_template(&profile.shell_template);
        if profile.name.is_empty() || !Path::new(&profile.workspace).is_absolute() {
            return Err("任务名称和工作区绝对路径不能为空".into());
        }
        profile.selection.included = profile
            .selection
            .included
            .iter()
            .map(|p| normal_relative(p))
            .collect::<Result<Vec<_>, _>>()?;
        profile.selection.excluded = profile
            .selection
            .excluded
            .iter()
            .map(|p| normal_relative(p))
            .collect::<Result<Vec<_>, _>>()?;
        profile.selection.included.sort();
        profile.selection.included.dedup();
        profile.selection.excluded.sort();
        profile.selection.excluded.dedup();
        if profile.schedule.enabled && !valid_daily_time(&profile.schedule.daily_time) {
            return Err("每日执行时间必须为 HH:mm".into());
        }
        let mut items = profiles(&self.db);
        items.retain(|p| p.id != profile.id);
        items.insert(0, profile.clone());
        self.db.set_setting("deploymentProfiles", &items)?;
        Ok(profile)
    }
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut items = profiles(&self.db);
        items.retain(|p| p.id != id);
        self.db.set_setting("deploymentProfiles", &items)
    }
    pub fn tree(&self, workspace: &str, relative: &str) -> Result<Vec<DirectoryEntry>, String> {
        let relative = normal_relative(relative)?;
        let root = Path::new(workspace);
        if !root.is_absolute()
            || !root.is_dir()
            || fs::symlink_metadata(root)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
        {
            return Err("工作区目录不存在".into());
        }
        let path = if relative == "." {
            root.to_path_buf()
        } else {
            root.join(&relative)
        };
        let mut check = root.to_path_buf();
        for part in path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .components()
        {
            check.push(part);
            if fs::symlink_metadata(&check)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("不能打开符号链接目录".into());
            }
        }
        let mut items = Vec::new();
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            items.push(DirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                kind: if meta.file_type().is_symlink() {
                    EntryKind::Symlink
                } else if meta.is_dir() {
                    EntryKind::Directory
                } else if meta.is_file() {
                    EntryKind::File
                } else {
                    EntryKind::Other
                },
                size: meta.is_file().then_some(meta.len()),
                modified_at: None,
            });
        }
        items.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(items)
    }
    pub fn preview(&self, id: &str) -> Result<DeploymentPreview, String> {
        let profile = self.get(id)?;
        validate_profile(&profile)?;
        let mut files = Vec::new();
        let mut total_size = 0;
        for (relative, path) in selected_files(&profile)? {
            let (size, sha256) = sha256_file(&path)?;
            total_size += size;
            files.push(DeploymentFile {
                relative_path: relative,
                size,
                sha256,
            });
        }
        if files.is_empty() {
            return Err("没有选中的文件".into());
        }
        let archive_file_name = resolved_archive_name(&profile, None)?;
        Ok(DeploymentPreview {
            remote_target_directory: profile.remote_directory.clone(),
            archive_file_name: archive_file_name.clone(),
            command_preview: if profile.shell_template.trim().is_empty() {
                String::new()
            } else {
                shell_command(&profile, &files, archive_file_name.as_deref())
            },
            files,
            total_size,
            command_template: profile.shell_template,
        })
    }
    fn save_run(&self, run: &DeploymentRun) -> Result<(), String> {
        self.db.save_deployment_run(run)
    }
    fn set_status(&self, run: &mut DeploymentRun, status: &str) -> Result<(), String> {
        run.status = status.into();
        self.save_run(run)
    }
    fn finish(
        &self,
        run: &mut DeploymentRun,
        status: &str,
        error: Option<String>,
    ) -> Result<(), String> {
        run.status = status.into();
        run.error = error;
        run.finished_at = Some(Utc::now().to_rfc3339());
        self.save_run(run)
    }
    async fn session_for(
        &self,
        profile: &DeploymentProfile,
        requested: Option<String>,
        scheduled: bool,
        cancelled: &AtomicBool,
    ) -> Result<(String, bool), String> {
        if let Some(id) = requested.filter(|id| !id.is_empty() && !scheduled) {
            if self.sessions.bookmark_id(&id)? != profile.bookmark_id
                || !self
                    .sessions
                    .list()
                    .iter()
                    .any(|session| session.id == id && session.status == SessionStatus::Connected)
            {
                return Err("当前 SSH 会话与任务不匹配或未连接".into());
            }
            return Ok((id, false));
        }
        if let Some(session) = (!scheduled)
            .then(|| self.sessions.list())
            .into_iter()
            .flatten()
            .find(|s| s.bookmark_id == profile.bookmark_id && s.status == SessionStatus::Connected)
        {
            return Ok((session.id, false));
        }
        let bookmark = self
            .db
            .get_bookmark(&profile.bookmark_id)?
            .ok_or("连接不存在")?;
        if scheduled {
            for item in std::iter::once(bookmark.clone()).chain(
                self.db
                    .get_bookmark(&bookmark.jump_bookmark_id)?
                    .into_iter(),
            ) {
                if self.db.known_host(&item.host, item.port)?.is_none() {
                    return Err(format!("{} 的 Host Key 尚未确认", item.name));
                }
                if item.auth_type == AuthType::Password
                    && self.db.get_credential(&item.id).is_none()
                {
                    return Err(format!("{} 没有保存的认证凭据", item.name));
                }
            }
        }
        let summary = self
            .sessions
            .connect_wait(
                ConnectInput {
                    bookmark_id: profile.bookmark_id.clone(),
                    new_session: true,
                    credential: None,
                    remember_credential: false,
                    jump_credential: None,
                    remember_jump_credential: false,
                    non_interactive: scheduled,
                },
                Duration::from_secs(if scheduled { 45 } else { 90 }),
                cancelled,
            )
            .await?;
        Ok((summary.id, true))
    }
    pub async fn execute(
        &self,
        id: String,
        session_id: Option<String>,
        scheduled: bool,
        preview_archive_name: Option<String>,
    ) -> Result<DeploymentRun, String> {
        let profile = self.get(&id)?;
        let archive_file_name = resolved_archive_name(
            &profile,
            if scheduled {
                None
            } else {
                preview_archive_name.as_deref()
            },
        )?;
        let run_id = Uuid::new_v4().to_string();
        let mut run = DeploymentRun {
            id: run_id.clone(),
            deployment_id: id.clone(),
            bookmark_id: profile.bookmark_id.clone(),
            trigger_type: if scheduled { "scheduled" } else { "manual" }.into(),
            started_at: Utc::now().to_rfc3339(),
            finished_at: None,
            status: "draft".into(),
            selected_file_count: 0,
            archive_enabled: profile.archive_enabled,
            archive_size: None,
            manifest_sha256: None,
            remote_destination_dir: profile.remote_directory.clone(),
            command_exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: None,
            manifest: None,
            command_line: String::new(),
        };
        self.save_run(&run)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut active = self.active.lock().map_err(|_| "任务状态锁已损坏")?;
            if active.contains_key(&id) {
                self.finish(&mut run, "failed", Some("同一任务已有运行，已跳过".into()))?;
                return Ok(run);
            }
            active.insert(id.clone(), (run.id.clone(), cancelled.clone()));
        }
        let mut own_session = None;
        let result = self
            .execute_inner(
                &profile,
                &mut run,
                session_id,
                scheduled,
                archive_file_name.as_deref(),
                cancelled.clone(),
                &mut own_session,
            )
            .await;
        let finish_result = if let Err(error) = result {
            let status = if cancelled.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "failed"
            };
            self.finish(&mut run, status, Some(error))
        } else {
            Ok(())
        };
        if run.status != "awaiting-confirmation" {
            self.active
                .lock()
                .map_err(|_| "任务状态锁已损坏")?
                .remove(&id);
            if let Some(id) = own_session {
                let _ = self.sessions.disconnect(&id).await;
            }
        }
        finish_result?;
        Ok(run)
    }
    async fn execute_inner(
        &self,
        profile: &DeploymentProfile,
        run: &mut DeploymentRun,
        requested: Option<String>,
        scheduled: bool,
        archive_file_name: Option<&str>,
        cancelled: Arc<AtomicBool>,
        own_session: &mut Option<String>,
    ) -> Result<(), String> {
        self.set_status(run, "preparing")?;
        validate_profile(profile)?;
        let selected = selected_files(profile)?;
        if selected.is_empty() {
            return Err("没有选中的文件".into());
        }
        let temp = std::env::temp_dir().join(format!("luna-remote-deployment-{}", run.id));
        fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
        let result = self
            .package_and_upload(
                profile,
                run,
                &selected,
                &temp,
                requested,
                scheduled,
                archive_file_name,
                cancelled.clone(),
                own_session,
            )
            .await;
        let _ = fs::remove_dir_all(temp);
        result
    }
    async fn package_and_upload(
        &self,
        profile: &DeploymentProfile,
        run: &mut DeploymentRun,
        selected: &[(String, PathBuf)],
        temp: &Path,
        requested: Option<String>,
        scheduled: bool,
        archive_file_name: Option<&str>,
        cancelled: Arc<AtomicBool>,
        own_session: &mut Option<String>,
    ) -> Result<(), String> {
        self.set_status(run, "packaging")?;
        let snapshot = temp.join("files");
        let mut files = Vec::new();
        for (relative, source) in selected {
            let mut file = copy_snapshot(source, &snapshot.join(relative), &cancelled)?;
            file.relative_path = relative.clone();
            files.push(file);
        }
        let manifest = serde_json::to_vec_pretty(&json!({"deploymentId": profile.id, "deploymentName": profile.name, "bookmarkId": profile.bookmark_id, "runId": run.id, "sourceWorkspace": profile.workspace, "remoteTargetDirectory": profile.remote_directory, "archiveFileName": archive_file_name, "archiveFormat": profile.archive_enabled.then_some(profile.archive_format), "shell": profile.shell, "selectedFileCount": files.len(), "selectedFiles": files, "archiveEnabled": profile.archive_enabled, "createdAt": Utc::now().to_rfc3339()})).map_err(|e| e.to_string())?;
        run.selected_file_count = files.len();
        run.manifest_sha256 = Some(format!("{:x}", Sha256::digest(&manifest)));
        run.manifest = Some(String::from_utf8_lossy(&manifest).into_owned());
        self.save_run(run)?;
        if profile.archive_enabled {
            let archive_path = temp.join(archive_file_name.expect("archive name"));
            run.archive_size = Some(match profile.archive_format {
                ArchiveFormat::Zip => build_zip(&snapshot, &archive_path, &files, &cancelled)?,
                ArchiveFormat::TarGz => build_tar_gz(&snapshot, &archive_path, &files, &cancelled)?,
            });
            self.save_run(run)?;
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let (session_id, created) = self
            .session_for(profile, requested, scheduled, &cancelled)
            .await?;
        if created {
            *own_session = Some(session_id.clone());
        }
        self.set_status(run, "uploading")?;
        let sftp = self.sessions.sftp(&session_id).await?;
        ensure_remote_directory(&sftp, &run.remote_destination_dir).await?;
        if profile.archive_enabled {
            upload(
                &sftp,
                &temp.join(archive_file_name.expect("archive name")),
                &remote_join(
                    &run.remote_destination_dir,
                    archive_file_name.expect("archive name"),
                ),
                &cancelled,
            )
            .await?;
        } else {
            for file in &files {
                upload(
                    &sftp,
                    &snapshot.join(&file.relative_path),
                    &remote_join(&run.remote_destination_dir, &file.relative_path),
                    &cancelled,
                )
                .await?;
            }
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if !profile.shell_template.trim().is_empty() {
            run.command_line = shell_command(profile, &files, archive_file_name);
            self.save_run(run)?;
        }
        if !scheduled && profile.confirm_manual && !profile.shell_template.trim().is_empty() {
            self.set_status(run, "awaiting-confirmation")?;
            self.pending.lock().map_err(|_| "任务状态锁已损坏")?.insert(
                run.id.clone(),
                PendingRun {
                    profile: profile.clone(),
                    session_id,
                    own_session: created,
                    cancelled,
                },
            );
            *own_session = None;
            return Ok(());
        }
        self.execute_command(profile, run, &session_id, &cancelled)
            .await
    }
    async fn execute_command(
        &self,
        profile: &DeploymentProfile,
        run: &mut DeploymentRun,
        session_id: &str,
        cancelled: &AtomicBool,
    ) -> Result<(), String> {
        if profile.shell_template.trim().is_empty() {
            return self.finish(run, "succeeded", None);
        }
        self.set_status(run, "executing-command")?;
        let (code, stdout, stderr) = match self
            .sessions
            .execute_deployment_command(session_id, &run.command_line, cancelled)
            .await
        {
            Ok(value) => value,
            Err(error) => {
                run.stdout = error.stdout;
                run.stderr = error.stderr;
                self.save_run(run)?;
                return Err(error.message);
            }
        };
        run.command_exit_code = Some(code);
        run.stdout = stdout;
        run.stderr = stderr;
        if code == 0 {
            self.finish(run, "succeeded", None)
        } else {
            let output = if run.stderr.trim().is_empty() {
                &run.stdout
            } else {
                &run.stderr
            };
            let message = command_failure(code, output);
            self.finish(run, "failed", Some(message))
        }
    }
    pub async fn confirm(&self, id: &str) -> Result<DeploymentRun, String> {
        let mut run = self.db.get_deployment_run(id)?.ok_or("运行记录不存在")?;
        let pending = self
            .pending
            .lock()
            .map_err(|_| "任务状态锁已损坏")?
            .remove(id)
            .ok_or("没有等待确认的部署")?;
        let result = self
            .execute_command(
                &pending.profile,
                &mut run,
                &pending.session_id,
                &pending.cancelled,
            )
            .await;
        let finish_result = if let Err(error) = result {
            self.finish(
                &mut run,
                if pending.cancelled.load(Ordering::Relaxed) {
                    "cancelled"
                } else {
                    "failed"
                },
                Some(error),
            )
        } else {
            Ok(())
        };
        self.active
            .lock()
            .map_err(|_| "任务状态锁已损坏")?
            .remove(&run.deployment_id);
        if pending.own_session {
            let _ = self.sessions.disconnect(&pending.session_id).await;
        }
        finish_result?;
        Ok(run)
    }
    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let run = self.db.get_deployment_run(id)?.ok_or("运行记录不存在")?;
        if let Some((active_id, control)) = self
            .active
            .lock()
            .map_err(|_| "任务状态锁已损坏")?
            .get(&run.deployment_id)
        {
            if active_id == id {
                control.store(true, Ordering::Relaxed);
            }
        }
        let pending = self
            .pending
            .lock()
            .map_err(|_| "任务状态锁已损坏")?
            .remove(id);
        if let Some(pending) = pending {
            let mut run = run;
            let finish_result = self.finish(&mut run, "cancelled", Some("已取消".into()));
            self.active
                .lock()
                .map_err(|_| "任务状态锁已损坏")?
                .remove(&run.deployment_id);
            if pending.own_session {
                let _ = self.sessions.disconnect(&pending.session_id).await;
            }
            finish_result?;
        }
        Ok(())
    }
    pub fn remove_runs(&self, ids: &[String]) -> Result<(), String> {
        for id in ids {
            if let Some(run) = self.db.get_deployment_run(id)? {
                if !["succeeded", "failed", "cancelled"].contains(&run.status.as_str()) {
                    return Err("运行中的历史不能删除，请先取消".into());
                }
            }
        }
        self.db.remove_deployment_runs(ids)
    }
    pub fn start_scheduler(self: &Arc<Self>) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            loop {
                interval.tick().await;
                let now = Local::now();
                let date = now.format("%Y-%m-%d").to_string();
                let minute = now.format("%H:%M").to_string();
                let all = profiles(&manager.db);
                let mut due = Vec::new();
                if let Ok(mut triggered) = manager.triggered.lock() {
                    triggered.retain(|key| key.starts_with(&date));
                    for profile in all {
                        let key = format!("{date}:{}", profile.id);
                        if profile.schedule.enabled
                            && profile.schedule.daily_time == minute
                            && triggered.insert(key)
                        {
                            due.push(profile.id);
                        }
                    }
                }
                for id in due {
                    let manager = manager.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = manager.execute(id, None, true, None).await;
                    });
                }
            }
        });
    }
}

fn valid_daily_time(value: &str) -> bool {
    let Some((hour, minute)) = value.split_once(':') else {
        return false;
    };
    hour.len() == 2
        && minute.len() == 2
        && hour.parse::<u8>().is_ok_and(|v| v < 24)
        && minute.parse::<u8>().is_ok_and(|v| v < 60)
}

#[tauri::command]
pub fn deployments_list(state: State<AppState>, bookmark_id: String) -> Vec<DeploymentProfile> {
    state.deployments.list(&bookmark_id)
}
#[tauri::command]
pub fn deployments_save(
    state: State<AppState>,
    profile: DeploymentProfile,
) -> Result<DeploymentProfile, String> {
    state.deployments.save(profile)
}
#[tauri::command]
pub fn deployments_remove(state: State<AppState>, id: String) -> Result<(), String> {
    state.deployments.remove(&id)
}
#[tauri::command]
pub fn deployments_tree(
    state: State<AppState>,
    workspace: String,
    path: String,
) -> Result<Vec<DirectoryEntry>, String> {
    state.deployments.tree(&workspace, &path)
}
#[tauri::command]
pub fn deployments_preview(
    state: State<AppState>,
    id: String,
    session_id: Option<String>,
) -> Result<DeploymentPreview, String> {
    let _ = session_id;
    state.deployments.preview(&id)
}
#[tauri::command]
pub async fn deployments_execute(
    state: State<'_, AppState>,
    id: String,
    session_id: Option<String>,
    archive_file_name: Option<String>,
) -> Result<DeploymentRun, String> {
    state
        .deployments
        .execute(id, session_id, false, archive_file_name)
        .await
}
#[tauri::command]
pub async fn deployments_confirm(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<DeploymentRun, String> {
    state.deployments.confirm(&run_id).await
}
#[tauri::command]
pub async fn deployments_cancel(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    state.deployments.cancel(&run_id).await
}
#[tauri::command]
pub fn deployment_runs_list(
    state: State<AppState>,
    deployment_id: String,
) -> Result<Vec<DeploymentRun>, String> {
    state.db.list_deployment_runs(&deployment_id)
}
#[tauri::command]
pub fn deployment_run_get(
    state: State<AppState>,
    id: String,
) -> Result<Option<DeploymentRun>, String> {
    state.db.get_deployment_run(&id)
}
#[tauri::command]
pub fn deployment_run_remove(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    state.deployments.remove_runs(&ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ArchiveFormat, DeploymentSchedule, DeploymentSelection, DeploymentShell};

    fn test_profile(root: &Path) -> DeploymentProfile {
        DeploymentProfile {
            id: Uuid::new_v4().to_string(),
            bookmark_id: "bookmark".into(),
            name: "test".into(),
            workspace: root.to_string_lossy().into_owned(),
            selection: DeploymentSelection {
                included: vec![".".into()],
                excluded: vec!["one/skip.txt".into()],
            },
            remote_directory: "/srv/app".into(),
            archive_enabled: true,
            archive_format: ArchiveFormat::Zip,
            shell_template: String::new(),
            shell: DeploymentShell::Sh,
            confirm_manual: true,
            schedule: DeploymentSchedule::default(),
        }
    }

    #[test]
    fn selection_excludes_nested_file_and_rejects_traversal() {
        let root = std::env::temp_dir().join(format!("luna-selection-test-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("one")).unwrap();
        fs::create_dir_all(root.join("two")).unwrap();
        fs::write(root.join("one/skip.txt"), b"skip").unwrap();
        fs::write(root.join("one/keep.txt"), b"keep").unwrap();
        fs::write(root.join("two/中文 space.txt"), b"data").unwrap();
        let files = selected_files(&test_profile(&root)).unwrap();
        assert_eq!(
            files
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            vec!["one/keep.txt", "two/中文 space.txt"]
        );
        assert!(normal_relative("../secret").is_err());
        assert!(normal_relative("/absolute").is_err());
        assert!(remote_directory("/srv/../etc").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn selected_symlink_is_rejected() {
        let root = std::env::temp_dir().join(format!("luna-symlink-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("actual"), b"data").unwrap();
        std::os::unix::fs::symlink(root.join("actual"), root.join("link")).unwrap();
        let mut profile = test_profile(&root);
        profile.selection.excluded.clear();
        assert!(selected_files(&profile).unwrap_err().contains("符号链接"));
        profile.selection.excluded.push("link".into());
        assert_eq!(selected_files(&profile).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_profile_migrates_to_workspace_selection() {
        let profile: DeploymentProfile = serde_json::from_value(json!({"id": Uuid::new_v4().to_string(), "bookmarkId": "b", "name": "old", "localDirectory": "/tmp/old", "remoteDirectory": "/srv", "deleteExtraneous": true})).unwrap();
        assert_eq!(profile.workspace, "/tmp/old");
        assert_eq!(profile.selection.included, vec!["."]);
        assert!(!profile.archive_enabled);
        assert_eq!(profile.archive_format, ArchiveFormat::Zip);
        assert_eq!(profile.shell, DeploymentShell::Sh);
    }

    #[test]
    fn zip_keeps_unicode_paths_and_contents() {
        let root = std::env::temp_dir().join(format!("luna-zip-test-{}", Uuid::new_v4()));
        let snapshot = root.join("files");
        fs::create_dir_all(snapshot.join("目录")).unwrap();
        fs::write(snapshot.join("目录/space '中文.txt"), b"hello").unwrap();
        let file = DeploymentFile {
            relative_path: "目录/space '中文.txt".into(),
            size: 5,
            sha256: format!("{:x}", Sha256::digest(b"hello")),
        };
        let archive = root.join("package.zip");
        assert!(build_zip(&snapshot, &archive, &[file], &AtomicBool::new(false)).unwrap() > 0);
        let archive_bytes = fs::read(&archive).unwrap();
        let flags = u16::from_le_bytes([archive_bytes[6], archive_bytes[7]]);
        assert_ne!(flags & (1 << 11), 0, "ZIP filename must be marked UTF-8");
        let mut zip = zip::ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
        let mut content = String::new();
        zip.by_name("目录/space '中文.txt")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "hello");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tar_gz_keeps_relative_paths_and_contents() {
        let root = std::env::temp_dir().join(format!("luna-tar-test-{}", Uuid::new_v4()));
        let snapshot = root.join("files");
        fs::create_dir_all(snapshot.join("目录")).unwrap();
        fs::write(snapshot.join("目录/space '中文.txt"), b"hello").unwrap();
        let file = DeploymentFile {
            relative_path: "目录/space '中文.txt".into(),
            size: 5,
            sha256: String::new(),
        };
        let archive = root.join("package.tar.gz");
        assert!(build_tar_gz(&snapshot, &archive, &[file], &AtomicBool::new(false)).unwrap() > 0);
        let gzip = flate2::read::GzDecoder::new(fs::File::open(&archive).unwrap());
        let mut tar = tar::Archive::new(gzip);
        let mut entries = tar.entries().unwrap();
        let mut entry = entries.next().unwrap().unwrap();
        assert_eq!(
            entry.path().unwrap().to_string_lossy(),
            "目录/space '中文.txt"
        );
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        assert_eq!(content, "hello");
        assert!(entries.next().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_archive_name_matches_selected_format_and_rejects_invalid_name() {
        let mut profile = test_profile(Path::new("/tmp/my workspace"));
        profile.archive_format = ArchiveFormat::TarGz;
        let name = "my workspace_20260929123456.tar.gz";
        assert_eq!(archive_name(&profile, "20260929123456"), name);
        assert_eq!(
            resolved_archive_name(&profile, Some(name))
                .unwrap()
                .as_deref(),
            Some(name)
        );
        assert!(resolved_archive_name(&profile, Some("../other.tar.gz")).is_err());
        assert!(
            resolved_archive_name(&profile, Some("my workspace_20261399123456.tar.gz")).is_err()
        );
        assert!(resolved_archive_name(&profile, Some("my workspace_20260929123456.zip")).is_err());
    }

    #[test]
    fn output_paths_are_direct_and_shell_variables_are_quoted() {
        let mut profile = test_profile(Path::new("/tmp/workspace"));
        profile.remote_directory = "/srv/space '中文".into();
        profile.shell_template = r#"ls "${LUNA_FILE_PATH}""#.into();
        let files = vec![DeploymentFile {
            relative_path: "nested/item.txt".into(),
            size: 1,
            sha256: String::new(),
        }];
        let archive = "workspace_20260929123456.zip";
        assert_eq!(archive_name(&profile, "20260929123456"), archive);
        assert_eq!(
            output_file(&profile, &files, Some(archive)),
            Some((archive.into(), format!("/srv/space '中文/{archive}")))
        );
        let command = shell_command(&profile, &files, Some(archive));
        assert!(command.contains(&format!("LUNA_FILE_NAME='{archive}'")));
        assert!(command.contains(&format!("LUNA_FILE_PATH='/srv/space '\\''中文/{archive}'")));
        assert!(command.contains(r#"sh -lc 'ls "${LUNA_FILE_PATH}"'"#));
        assert!(!command.contains("staging"));

        profile.shell = DeploymentShell::Bash;
        assert!(
            shell_command(&profile, &files, Some(archive))
                .contains(r#"bash -lc 'ls "${LUNA_FILE_PATH}"'"#)
        );

        profile.archive_enabled = false;
        assert_eq!(
            output_file(&profile, &files, None),
            Some(("item.txt".into(), "/srv/space '中文/nested/item.txt".into()))
        );
        assert!(output_file(&profile, &[files[0].clone(), files[0].clone()], None).is_none());
        assert_eq!(remote_join("/", "nested/item.txt"), "/nested/item.txt");
        assert_eq!(
            migrate_shell_template(
                r#"unzip "${LUNA_REMOTE_PACKAGE_PATH}" -d "${LUNA_REMOTE_TARGET_DIR}""#
            ),
            r#"unzip "${LUNA_FILE_PATH}" -d "${LUNA_TARGET_DIR}""#
        );
    }
}
