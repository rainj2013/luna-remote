use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use chrono::{Local, Utc};
use serde::{Deserialize, Serialize};
use russh_sftp::{
    client::{SftpSession, error::Error as SftpError},
    protocol::StatusCode,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    commands::AppState,
    database::Database,
    models::{
        ArchiveFormat, AuthType, ConnectInput, DeploymentFile, DeploymentPreview,
        DeploymentPreviewProgress, DeploymentProgress, DeploymentHookTemplate, AppEvent,
        DeploymentProfile, DeploymentRun, DirectoryEntry, EntryKind, SessionStatus, SessionSummary,
    },
    sessions::SessionManager,
};

pub struct DeploymentManager {
    app: AppHandle,
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
        return Err("上传目标目录必须是无穿越的绝对路径".into());
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

fn sha256_file(path: &Path, mut on_bytes: impl FnMut(u64)) -> Result<(u64, String), String> {
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
        on_bytes(count as u64);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

fn copy_snapshot(
    source: &Path,
    destination: &Path,
    cancelled: &AtomicBool,
    progress: Option<&ProgressReporter>,
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
        if let Some(progress) = progress { progress.advance(count as u64); }
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
    progress: Option<&ProgressReporter>,
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
            if let Some(progress) = progress { progress.advance(n as u64); }
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(fs::metadata(archive).map_err(|e| e.to_string())?.len())
}

struct CancellableReader<'a> {
    file: fs::File,
    cancelled: &'a AtomicBool,
    progress: Option<&'a ProgressReporter>,
}

impl Read for CancellableReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("已取消"));
        }
        let count = self.file.read(buffer)?;
        if let Some(progress) = self.progress { progress.advance(count as u64); }
        Ok(count)
    }
}

fn build_tar_gz(
    snapshot: &Path,
    archive: &Path,
    files: &[DeploymentFile],
    cancelled: &AtomicBool,
    progress: Option<&ProgressReporter>,
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
                progress,
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

fn connected_session_for_bookmark(sessions: Vec<SessionSummary>, bookmark_id: &str) -> Option<String> {
    sessions.into_iter()
        .find(|session| session.bookmark_id == bookmark_id && session.status == SessionStatus::Connected)
        .map(|session| session.id)
}

fn prepare_profile(db: &Database, mut profile: DeploymentProfile) -> Result<DeploymentProfile, String> {
    if db.get_bookmark(&profile.bookmark_id)?.is_none() {
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
    profile.hook_url = profile.hook_url.trim().to_string();
    if !profile.hook_url.is_empty() {
        let url = reqwest::Url::parse(&profile.hook_url).map_err(|_| "HTTP Hook URL 无效")?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("HTTP Hook 只支持 http 或 https URL".into());
        }
        if hook_template_mode(&profile) == DeploymentHookTemplate::Custom && !profile.hook_body.trim().is_empty() {
            render_hook_template(&profile.hook_body, &hook_template_values(&profile, None))?;
        }
    }
    if profile.name.is_empty() || !Path::new(&profile.workspace).is_absolute() {
        return Err("任务名称和工作区绝对路径不能为空".into());
    }
    profile.selection.included = profile.selection.included.iter().map(|p| normal_relative(p)).collect::<Result<Vec<_>, _>>()?;
    profile.selection.excluded = profile.selection.excluded.iter().map(|p| normal_relative(p)).collect::<Result<Vec<_>, _>>()?;
    profile.selection.included.sort();
    profile.selection.included.dedup();
    profile.selection.excluded.sort();
    profile.selection.excluded.dedup();
    if profile.schedule.enabled && profile.selection.included.is_empty() {
        return Err("启用定时任务前请至少选择一个文件或目录".into());
    }
    if profile.schedule.enabled && !valid_daily_time(&profile.schedule.daily_time) {
        return Err("每日执行时间必须为 HH:mm".into());
    }
    Ok(profile)
}

fn import_profiles_into_db(db: &Database, bookmark_id: &str, tasks: Vec<DeploymentProfile>) -> Result<Vec<DeploymentProfile>, String> {
    if tasks.is_empty() || tasks.len() > 100 {
        return Err("部署任务包应包含 1 到 100 个任务".into());
    }
    let imported = tasks.into_iter().map(|mut task| {
        task.id = Uuid::new_v4().to_string();
        task.bookmark_id = bookmark_id.to_string();
        prepare_profile(db, task)
    }).collect::<Result<Vec<_>, _>>()?;
    let mut items = profiles(db);
    for task in imported.iter().rev() {
        items.insert(0, task.clone());
    }
    db.set_setting("deploymentProfiles", &items)?;
    Ok(imported)
}

const DEPLOYMENT_BUNDLE_FORMAT: &str = "luna-remote-deployments";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentBundle {
    format: String,
    version: u32,
    exported_at: String,
    source_connection: String,
    tasks: Vec<DeploymentProfile>,
}

fn picked_path(value: Option<FilePath>) -> Option<PathBuf> {
    value?.into_path().ok()
}

fn render_shell_template(template: &str) -> String {
    let mut rendered = template.to_string();
    for name in ["UPLOAD_DIR", "FILE_NAME", "FILE_PATH"] {
        let token = format!("{{{{{name}}}}}");
        let expansion = format!("\"${{{name}}}\"");
        rendered = rendered.replace(&format!("\"{token}\""), &expansion);
        rendered = rendered.replace(&format!("'{token}'"), &expansion);
        rendered = rendered.replace(&token, &expansion);
    }
    rendered
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
        ("UPLOAD_DIR", profile.remote_directory.as_str()),
        ("FILE_NAME", file_name),
        ("FILE_PATH", file_path),
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
        shell_quote(&render_shell_template(&profile.shell_template))
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
    progress: Option<&ProgressReporter>,
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
        if let Some(progress) = progress { progress.advance(count as u64); }
    }
    writer.shutdown().await.map_err(|e| e.to_string())
}

impl DeploymentManager {
    pub fn new(db: Arc<Database>, sessions: Arc<SessionManager>, app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
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
    pub fn save(&self, profile: DeploymentProfile) -> Result<DeploymentProfile, String> {
        let profile = prepare_profile(&self.db, profile)?;
        let mut items = profiles(&self.db);
        items.retain(|p| p.id != profile.id);
        items.insert(0, profile.clone());
        self.db.set_setting("deploymentProfiles", &items)?;
        Ok(profile)
    }
    pub fn list_all(&self) -> Vec<DeploymentProfile> {
        profiles(&self.db)
    }
    pub fn import_profiles(&self, bookmark_id: &str, tasks: Vec<DeploymentProfile>) -> Result<Vec<DeploymentProfile>, String> {
        import_profiles_into_db(&self.db, bookmark_id, tasks)
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
    pub fn preview(&self, profile: DeploymentProfile, request_id: &str, mut on_progress: impl FnMut(DeploymentPreviewProgress)) -> Result<DeploymentPreview, String> {
        let profile = prepare_profile(&self.db, profile)?;
        validate_profile(&profile)?;
        let mut progress = DeploymentPreviewProgress {
            request_id: request_id.into(), phase: "scanning".into(),
            files_total: 0, files_processed: 0, bytes_total: 0, bytes_processed: 0,
        };
        on_progress(progress.clone());
        let selected = selected_files(&profile)?;
        progress.files_total = selected.len();
        progress.bytes_total = selected.iter().try_fold(0u64, |total, (_, path)| {
            fs::metadata(path).map(|meta| total.saturating_add(meta.len())).map_err(|e| e.to_string())
        })?;
        progress.phase = "hashing".into();
        on_progress(progress.clone());
        let mut files = Vec::new();
        let mut total_size = 0;
        let mut last_reported_bytes = 0;
        for (relative, path) in selected {
            let (size, sha256) = sha256_file(&path, |count| {
                progress.bytes_processed = progress.bytes_processed.saturating_add(count);
                if progress.bytes_processed.saturating_sub(last_reported_bytes) >= 1024 * 1024 {
                    on_progress(progress.clone());
                    last_reported_bytes = progress.bytes_processed;
                }
            })?;
            total_size += size;
            files.push(DeploymentFile {
                relative_path: relative,
                size,
                sha256,
            });
            progress.files_processed += 1;
            on_progress(progress.clone());
            last_reported_bytes = progress.bytes_processed;
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
    async fn deliver_hook(&self, profile: &DeploymentProfile, run: &mut DeploymentRun) {
        if profile.hook_url.is_empty() || !matches!(run.status.as_str(), "succeeded" | "failed") { return; }
        let result = async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build().map_err(|_| "创建 HTTP 客户端失败".to_string())?;
            let payload = hook_payload(profile, run)?;
            let response = client.post(&profile.hook_url).json(&payload).send().await
                .map_err(|_| "HTTP 请求失败或超时".to_string())?;
            let status = response.status();
            if !status.is_success() { return Err(format!("HTTP 状态码 {status}")); }
            if is_feishu_webhook(&profile.hook_url) {
                let body: serde_json::Value = response.json().await.map_err(|_| "飞书 Hook 响应不是 JSON".to_string())?;
                if body.get("code").and_then(|code| code.as_i64()) != Some(0) {
                    return Err(format!("飞书 Hook 返回错误：{}", body.get("msg").and_then(|msg| msg.as_str()).unwrap_or("未知错误")));
                }
            }
            Ok(())
        }.await;
        run.hook_error = result.err();
        let _ = self.save_run(run);
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
        if let Some(id) = connected_session_for_bookmark(self.sessions.list(), &profile.bookmark_id) {
            return Ok((id, false));
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
                    return Err(format!("目标连接当前未连接；自动重连需要保存 {} 的认证凭据", item.name));
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
        request_id: Option<String>,
    ) -> Result<DeploymentRun, String> {
        self.execute_with_trigger(id, session_id, scheduled, false, preview_archive_name, request_id, Uuid::new_v4().to_string(), None).await
    }
    pub async fn execute_with_trigger(
        &self,
        id: String,
        session_id: Option<String>,
        scheduled: bool,
        api_trigger: bool,
        preview_archive_name: Option<String>,
        request_id: Option<String>,
        run_id: String,
        created: Option<tokio::sync::oneshot::Sender<()>>,
    ) -> Result<DeploymentRun, String> {
        let profile = self.get(&id)?;
        let archive_file_name = resolved_archive_name(
            &profile,
            if scheduled || api_trigger {
                None
            } else {
                preview_archive_name.as_deref()
            },
        )?;
        let mut run = DeploymentRun {
            id: run_id.clone(),
            deployment_id: id.clone(),
            bookmark_id: profile.bookmark_id.clone(),
            trigger_type: if scheduled { "scheduled" } else if api_trigger { "api" } else { "manual" }.into(),
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
            hook_error: None,
        };
        self.save_run(&run)?;
        if let Some(created) = created { let _ = created.send(()); }
        let cancelled = Arc::new(AtomicBool::new(false));
        let duplicate = {
            let mut active = self.active.lock().map_err(|_| "任务状态锁已损坏")?;
            if active.contains_key(&id) {
                true
            } else {
                active.insert(id.clone(), (run.id.clone(), cancelled.clone()));
                false
            }
        };
        if duplicate {
            self.finish(&mut run, "failed", Some("同一任务已有运行，已跳过".into()))?;
            self.deliver_hook(&profile, &mut run).await;
            return Ok(run);
        }
        let mut own_session = None;
        let result = self
            .execute_inner(
                &profile,
                &mut run,
                session_id,
                scheduled || api_trigger,
                archive_file_name.as_deref(),
                cancelled.clone(),
                &mut own_session,
                request_id.as_deref(),
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
        self.deliver_hook(&profile, &mut run).await;
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
        request_id: Option<&str>,
    ) -> Result<(), String> {
        let progress = request_id.filter(|_| !scheduled).map(|id| ProgressReporter {
            app: self.app.clone(), request_id: id.into(),
            state: Mutex::new((String::new(), 0, 0, Instant::now())),
        });
        if let Some(progress) = &progress { progress.phase("preparing", 0); }
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
                progress.as_ref(),
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
        progress: Option<&ProgressReporter>,
    ) -> Result<(), String> {
        self.set_status(run, "packaging")?;
        let total_bytes = selected.iter().map(|(_, path)| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)).sum();
        if let Some(progress) = progress { progress.phase("snapshot", total_bytes); }
        let snapshot = temp.join("files");
        let mut files = Vec::new();
        for (relative, source) in selected {
            let mut file = copy_snapshot(source, &snapshot.join(relative), &cancelled, progress)?;
            file.relative_path = relative.clone();
            files.push(file);
        }
        let manifest = serde_json::to_vec_pretty(&json!({"deploymentId": profile.id, "deploymentName": profile.name, "bookmarkId": profile.bookmark_id, "runId": run.id, "sourceWorkspace": profile.workspace, "remoteTargetDirectory": profile.remote_directory, "archiveFileName": archive_file_name, "archiveFormat": profile.archive_enabled.then_some(profile.archive_format), "shell": profile.shell, "selectedFileCount": files.len(), "selectedFiles": files, "archiveEnabled": profile.archive_enabled, "createdAt": Utc::now().to_rfc3339()})).map_err(|e| e.to_string())?;
        run.selected_file_count = files.len();
        run.manifest_sha256 = Some(format!("{:x}", Sha256::digest(&manifest)));
        run.manifest = Some(String::from_utf8_lossy(&manifest).into_owned());
        self.save_run(run)?;
        if profile.archive_enabled {
            if let Some(progress) = progress { progress.phase("packaging", files.iter().map(|file| file.size).sum()); }
            let archive_path = temp.join(archive_file_name.expect("archive name"));
            run.archive_size = Some(match profile.archive_format {
                ArchiveFormat::Zip => build_zip(&snapshot, &archive_path, &files, &cancelled, progress)?,
                ArchiveFormat::TarGz => build_tar_gz(&snapshot, &archive_path, &files, &cancelled, progress)?,
            });
            self.save_run(run)?;
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if let Some(progress) = progress { progress.phase("connecting", 0); }
        let (session_id, created) = self
            .session_for(profile, requested, scheduled, &cancelled)
            .await?;
        if created {
            *own_session = Some(session_id.clone());
        }
        self.set_status(run, "uploading")?;
        if let Some(progress) = progress {
            progress.phase("uploading", if profile.archive_enabled { run.archive_size.unwrap_or(0) } else { files.iter().map(|file| file.size).sum() });
        }
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
                progress,
            )
            .await?;
        } else {
            for file in &files {
                upload(
                    &sftp,
                    &snapshot.join(&file.relative_path),
                    &remote_join(&run.remote_destination_dir, &file.relative_path),
                    &cancelled,
                    progress,
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
        if !profile.shell_template.trim().is_empty() {
            if let Some(progress) = progress { progress.phase("executing-command", 0); }
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
        self.deliver_hook(&pending.profile, &mut run).await;
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
                        let _ = manager.execute(id, None, true, None, None).await;
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
pub async fn deployments_export_bundle(
    app: AppHandle,
    state: State<'_, AppState>,
    bookmark_id: String,
) -> Result<Option<String>, String> {
    let bookmark = state.db.get_bookmark(&bookmark_id)?.ok_or("连接不存在")?;
    let tasks = state.deployments.list(&bookmark_id);
    if tasks.is_empty() { return Err("当前连接没有可导出的部署任务".into()); }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file()
        .set_title("导出部署任务")
        .set_file_name(format!("luna-remote-deployments-{}.json", Utc::now().format("%Y-%m-%d")))
        .add_filter("Luna Remote 部署任务", &["json"])
        .save_file(move |path| { let _ = sender.send(path); });
    let Some(path) = picked_path(receiver.await.ok().flatten()) else { return Ok(None); };
    let bundle = DeploymentBundle {
        format: DEPLOYMENT_BUNDLE_FORMAT.into(), version: 1,
        exported_at: Utc::now().to_rfc3339(), source_connection: bookmark.name,
        tasks,
    };
    fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&bundle).map_err(|error| error.to_string())?))
        .map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn deployments_pick_bundle(app: AppHandle) -> Result<Option<DeploymentBundle>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file()
        .set_title("导入部署任务")
        .add_filter("Luna Remote 部署任务", &["json"])
        .pick_file(move |path| { let _ = sender.send(path); });
    let Some(path) = picked_path(receiver.await.ok().flatten()) else { return Ok(None); };
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 10 * 1024 * 1024 {
        return Err("部署任务包必须是小于 10 MB 的普通 JSON 文件".into());
    }
    let bundle: DeploymentBundle = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("部署任务包格式无效：{error}"))?;
    if bundle.format != DEPLOYMENT_BUNDLE_FORMAT || bundle.version != 1 {
        return Err("不支持此部署任务包格式或版本".into());
    }
    if bundle.tasks.is_empty() || bundle.tasks.len() > 100 {
        return Err("部署任务包应包含 1 到 100 个任务".into());
    }
    Ok(Some(bundle))
}

#[tauri::command]
pub fn deployments_import_bundle(
    state: State<AppState>,
    bookmark_id: String,
    tasks: Vec<DeploymentProfile>,
) -> Result<Vec<DeploymentProfile>, String> {
    state.deployments.import_profiles(&bookmark_id, tasks)
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
pub async fn deployments_preview(
    state: State<'_, AppState>,
    app: AppHandle,
    profile: DeploymentProfile,
    request_id: String,
) -> Result<DeploymentPreview, String> {
    let deployments = Arc::clone(&state.deployments);
    tauri::async_runtime::spawn_blocking(move || {
        deployments.preview(profile, &request_id, |progress| {
            let _ = app.emit("app:event", AppEvent::DeploymentPreviewProgress(progress));
        })
    }).await.map_err(|error| error.to_string())?
}

fn trigger_label(trigger_type: &str) -> &'static str {
    match trigger_type {
        "scheduled" => "定时",
        "api" => "API",
        _ => "手工",
    }
}

fn hook_template_values(profile: &DeploymentProfile, run: Option<&DeploymentRun>) -> serde_json::Value {
    let duration_seconds = run.and_then(|run| {
        let finished = chrono::DateTime::parse_from_rfc3339(run.finished_at.as_deref()?).ok()?;
        let started = chrono::DateTime::parse_from_rfc3339(&run.started_at).ok()?;
        Some((finished - started).num_seconds().max(0))
    });
    let summary = format!(
        "部署{}：{}\n触发方式：{}\n上传目录：{}\n运行 ID：{}{}",
        if run.is_none_or(|run| run.status == "succeeded") { "成功" } else { "失败" },
        profile.name,
        run.map_or("手工", |run| trigger_label(&run.trigger_type)),
        run.map_or(profile.remote_directory.as_str(), |run| run.remote_destination_dir.as_str()),
        run.map_or("sample-run", |run| run.id.as_str()),
        run.and_then(|run| run.error.as_ref()).map(|error| format!("\n原因：{error}")).unwrap_or_default(),
    );
    json!({
        "summary": summary,
        "runId": run.map_or("sample-run", |run| run.id.as_str()),
        "deploymentId": profile.id,
        "deploymentName": profile.name,
        "taskName": profile.name,
        "bookmarkId": run.map_or(profile.bookmark_id.as_str(), |run| run.bookmark_id.as_str()),
        "triggerType": run.map_or("manual", |run| run.trigger_type.as_str()),
        "status": run.map_or("succeeded", |run| run.status.as_str()),
        "succeeded": run.is_none_or(|run| run.status == "succeeded"),
        "startedAt": run.map(|run| format_hook_datetime(&run.started_at)).unwrap_or_else(|| "2026-01-01 00:00:00".into()),
        "finishedAt": run.map(|run| run.finished_at.as_deref().map(format_hook_datetime)).unwrap_or(Some("2026-01-01 00:01:00".into())),
        "durationSeconds": duration_seconds.or(if run.is_none() { Some(60) } else { None }),
        "selectedFileCount": run.map_or(1, |run| run.selected_file_count),
        "archiveSize": run.map(|run| run.archive_size).unwrap_or(Some(1024)),
        "archiveSizeText": run.map(|run| run.archive_size.map(format_hook_size)).unwrap_or(Some("1 KB".into())),
        "uploadDirectory": run.map_or(profile.remote_directory.as_str(), |run| run.remote_destination_dir.as_str()),
        "commandExitCode": run.map(|run| run.command_exit_code).unwrap_or(Some(0)),
        "error": run.map(|run| run.error.as_deref()).unwrap_or(Some("sample error")),
    })
}

fn format_hook_datetime(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Local).format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|_| value.to_string())
}

fn format_hook_size(size: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = size as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 { format!("{size} B") } else { format!("{value:.1} {}", UNITS[unit]) }
}

fn render_hook_template(template: &str, values: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut rendered = String::with_capacity(template.len());
    let mut remaining = template;
    let mut inside_string = false;
    let mut escaped = false;
    while let Some(start) = remaining.find("{{") {
        let literal = &remaining[..start];
        rendered.push_str(literal);
        for byte in literal.bytes() {
            if escaped { escaped = false; }
            else if byte == b'\\' { escaped = true; }
            else if byte == b'"' { inside_string = !inside_string; }
        }
        let tail = &remaining[start + 2..];
        let end = tail.find("}}").ok_or("Webhook 请求体变量没有结束标记 }}")?;
        let token = tail[..end].trim();
        let name = token.strip_prefix("json.").unwrap_or(token);
        let value = values.get(name).ok_or_else(|| format!("Webhook 请求体变量不存在：{token}"))?;
        if inside_string && !token.starts_with("json.") {
            let value = value.as_str().map(str::to_string).unwrap_or_else(|| if value.is_null() { String::new() } else { value.to_string() });
            let quoted = serde_json::to_string(&value).map_err(|error| error.to_string())?;
            rendered.push_str(&quoted[1..quoted.len() - 1]);
        } else {
            rendered.push_str(&value.to_string());
        }
        remaining = &tail[end + 2..];
    }
    rendered.push_str(remaining);
    serde_json::from_str(&rendered).map_err(|error| format!("Webhook 请求体不是有效 JSON：{error}"))
}

fn hook_payload(profile: &DeploymentProfile, run: &DeploymentRun) -> Result<serde_json::Value, String> {
    let values = hook_template_values(profile, Some(run));
    if hook_template_mode(profile) == DeploymentHookTemplate::Feishu {
        let succeeded = run.status == "succeeded";
        let title = format!("{} 部署{}：{}", if succeeded { "✅" } else { "🔴" }, if succeeded { "成功" } else { "失败" }, profile.name);
        let content = format!(
            "**任务**：{}\n**执行时间**：{} ~ {}\n**耗时**：{} 秒\n**压缩包大小**：{}\n**文件数量**：{}\n**触发方式**：{}\n**上传目录**：{}{}",
            profile.name,
            values["startedAt"].as_str().unwrap_or(""),
            values["finishedAt"].as_str().unwrap_or(""),
            values["durationSeconds"].as_i64().unwrap_or(0),
            values["archiveSizeText"].as_str().unwrap_or("未打包"),
            run.selected_file_count,
            trigger_label(&run.trigger_type),
            run.remote_destination_dir,
            run.error.as_ref().map(|error| format!("\n**失败原因**：{error}")).unwrap_or_default(),
        );
        return Ok(json!({
            "msg_type": "interactive",
            "card": {
                "config": { "wide_screen_mode": true, "update_multi": true },
                "header": {
                    "title": { "tag": "plain_text", "content": title },
                    "template": if succeeded { "green" } else { "red" },
                },
                "elements": [{ "tag": "div", "text": { "tag": "lark_md", "content": content } }],
            },
        }));
    }
    if !profile.hook_body.trim().is_empty() {
        return render_hook_template(&profile.hook_body, &values);
    }
    Ok(json!({
        "event": "deployment.finished",
        "summary": values["summary"],
        "runId": values["runId"],
        "deploymentId": values["deploymentId"],
        "deploymentName": values["deploymentName"],
        "bookmarkId": values["bookmarkId"],
        "triggerType": values["triggerType"],
        "status": values["status"],
        "startedAt": values["startedAt"],
        "finishedAt": values["finishedAt"],
        "selectedFileCount": values["selectedFileCount"],
        "archiveSize": values["archiveSize"],
        "archiveSizeText": values["archiveSizeText"],
        "durationSeconds": values["durationSeconds"],
        "succeeded": values["succeeded"],
        "uploadDirectory": values["uploadDirectory"],
        "commandExitCode": values["commandExitCode"],
        "error": values["error"],
    }))
}

fn is_feishu_webhook(url: &str) -> bool {
    reqwest::Url::parse(url).ok()
        .and_then(|url| url.host_str().map(|host| host == "open.feishu.cn" || host == "open.larksuite.com"))
        .unwrap_or(false)
}

fn hook_template_mode(profile: &DeploymentProfile) -> DeploymentHookTemplate {
    profile.hook_template.unwrap_or_else(|| {
        if profile.hook_body.trim().is_empty() && is_feishu_webhook(&profile.hook_url) {
            DeploymentHookTemplate::Feishu
        } else {
            DeploymentHookTemplate::Custom
        }
    })
}

struct ProgressReporter {
    app: AppHandle,
    request_id: String,
    state: Mutex<(String, u64, u64, Instant)>,
}

impl ProgressReporter {
    fn phase(&self, phase: &str, total: u64) {
        if let Ok(mut state) = self.state.lock() {
            *state = (phase.into(), total, 0, Instant::now());
            self.emit(&state);
        }
    }
    fn advance(&self, bytes: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.2 = state.2.saturating_add(bytes);
            if state.3.elapsed() >= Duration::from_millis(100) || state.2 >= state.1 {
                self.emit(&state);
                state.3 = Instant::now();
            }
        }
    }
    fn emit(&self, state: &(String, u64, u64, Instant)) {
        let _ = self.app.emit("app:event", AppEvent::DeploymentProgress(DeploymentProgress {
            request_id: self.request_id.clone(), phase: state.0.clone(),
            bytes_total: state.1, bytes_processed: state.2,
        }));
    }
}
#[tauri::command]
pub async fn deployments_execute(
    state: State<'_, AppState>,
    id: String,
    session_id: Option<String>,
    archive_file_name: Option<String>,
    request_id: Option<String>,
) -> Result<DeploymentRun, String> {
    state
        .deployments
        .execute(id, session_id, false, archive_file_name, request_id)
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
    use crate::models::{ArchiveFormat, AuthType, BookmarkInput, DeploymentSchedule, DeploymentSelection, DeploymentShell};

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
            shell: DeploymentShell::Bash,
            confirm_manual: true,
            schedule: DeploymentSchedule::default(),
            hook_url: String::new(),
            hook_template: None,
            hook_body: String::new(),
        }
    }

    #[test]
    fn connected_target_session_is_reused_for_scheduled_runs() {
        let summary = |id: &str, bookmark_id: &str, status: SessionStatus| SessionSummary {
            id: id.into(), bookmark_id: bookmark_id.into(), title: id.into(), status, error: None,
        };
        let sessions = vec![
            summary("old-target", "target", SessionStatus::Disconnected),
            summary("jump", "jump", SessionStatus::Connected),
            summary("live-target", "target", SessionStatus::Connected),
        ];
        assert_eq!(connected_session_for_bookmark(sessions, "target"), Some("live-target".into()));
        assert_eq!(connected_session_for_bookmark(vec![summary("jump", "jump", SessionStatus::Connected)], "target"), None);
    }

    #[test]
    fn bundle_import_maps_connection_and_ids_without_partial_writes() {
        let path = std::env::temp_dir().join(format!("luna-deployment-import-{}.db", Uuid::new_v4()));
        let db = Database::open(&path, "luna-deployment-import-test").unwrap();
        let target = db.save_bookmark(BookmarkInput {
            id: None, name: "Target".into(), host: "example.com".into(), port: 22,
            username: "test".into(), auth_type: AuthType::Agent,
            private_key_path: String::new(), jump_bookmark_id: String::new(),
            group_name: String::new(), favorite: false, keepalive_enabled: true,
            keepalive_interval_seconds: 15, keepalive_count_max: 3, note: String::new(),
        }).unwrap();
        let mut source = test_profile(&std::env::temp_dir());
        source.name = " release ".into();
        source.schedule = DeploymentSchedule { enabled: true, daily_time: "09:30".into() };
        source.hook_url = "https://example.com/hook".into();
        source.hook_body = r#"{"task":{{deploymentName}}}"#.into();
        let bundle = DeploymentBundle {
            format: DEPLOYMENT_BUNDLE_FORMAT.into(), version: 1,
            exported_at: Utc::now().to_rfc3339(), source_connection: "Source".into(),
            tasks: vec![source.clone()],
        };
        let restored: DeploymentBundle = serde_json::from_str(&serde_json::to_string(&bundle).unwrap()).unwrap();
        let imported = import_profiles_into_db(&db, &target.id, restored.tasks).unwrap();
        assert_eq!(imported.len(), 1);
        assert_ne!(imported[0].id, source.id);
        assert_eq!(imported[0].bookmark_id, target.id);
        assert_eq!(imported[0].name, "release");
        assert!(imported[0].schedule.enabled);
        assert_eq!(imported[0].hook_url, source.hook_url);
        assert_eq!(profiles(&db).len(), 1);

        let mut invalid = source.clone();
        invalid.remote_directory = "../invalid".into();
        assert!(import_profiles_into_db(&db, &target.id, vec![source.clone(), invalid]).is_err());
        assert_eq!(profiles(&db).len(), 1);
        let mut empty_schedule = source.clone();
        empty_schedule.selection.included.clear();
        assert!(import_profiles_into_db(&db, &target.id, vec![empty_schedule]).is_err());
        assert_eq!(profiles(&db).len(), 1);
        assert!(import_profiles_into_db(&db, "missing-connection", vec![source]).is_err());
        assert_eq!(profiles(&db).len(), 1);
        drop(db);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn bundle_accepts_older_profile_defaults() {
        let mut value = serde_json::to_value(test_profile(&std::env::temp_dir())).unwrap();
        let task = value.as_object_mut().unwrap();
        task.remove("selection");
        task.remove("archiveFormat");
        task.remove("schedule");
        task.remove("hookUrl");
        task.remove("hookTemplate");
        task.remove("hookBody");
        let bundle = json!({
            "format": DEPLOYMENT_BUNDLE_FORMAT, "version": 1,
            "exportedAt": "2026-09-30T00:00:00Z", "sourceConnection": "Legacy",
            "tasks": [value],
        });
        let restored: DeploymentBundle = serde_json::from_value(bundle).unwrap();
        let profile = &restored.tasks[0];
        assert_eq!(profile.selection.included, ["."]);
        assert_eq!(profile.archive_format, ArchiveFormat::Zip);
        assert!(!profile.schedule.enabled);
        assert!(profile.hook_url.is_empty());
    }

    #[test]
    fn hook_payload_contains_message_and_event_fields() {
        let mut profile = test_profile(Path::new("/tmp"));
        profile.name = "test \"quoted\" {{status}}".into();
        let run = DeploymentRun {
            id: "run-1".into(), deployment_id: profile.id.clone(), bookmark_id: profile.bookmark_id.clone(),
            trigger_type: "manual".into(), started_at: "2026-09-30T00:00:00Z".into(),
            finished_at: Some("2026-09-30T00:01:00Z".into()), status: "failed".into(),
            selected_file_count: 1, archive_enabled: true, archive_size: Some(1),
            manifest_sha256: None, remote_destination_dir: "/srv/app".into(),
            command_exit_code: Some(1), stdout: String::new(), stderr: String::new(),
            error: Some("bad \"quote\"\nnext line".into()), manifest: None,
            command_line: String::new(), hook_error: None,
        };
        let body = hook_payload(&profile, &run).unwrap();
        let local_finished = format_hook_datetime(run.finished_at.as_deref().unwrap());
        assert_eq!(body["deploymentName"], profile.name);
        assert_eq!(body["error"], run.error.as_deref().unwrap());
        assert_eq!(body["commandExitCode"], 1);
        assert!(body["summary"].as_str().unwrap().contains("bad \"quote\""));
        assert_eq!(body["status"], "failed");
        profile.hook_url = "https://open.feishu.cn/open-apis/bot/v2/hook/test".into();
        let feishu = hook_payload(&profile, &run).unwrap();
        assert_eq!(feishu["msg_type"], "interactive");
        assert_eq!(feishu["card"]["header"]["template"], "red");
        assert!(feishu["card"]["header"]["title"]["content"].as_str().unwrap().contains("部署失败"));
        assert!(feishu["card"]["elements"][0]["text"]["content"].as_str().unwrap().contains("bad \"quote\""));
        assert!(feishu["card"]["elements"][0]["text"]["content"].as_str().unwrap().contains(&local_finished));
        assert!(feishu.get("event").is_none());
        profile.hook_template = Some(DeploymentHookTemplate::Custom);
        profile.hook_body = r#"{"msg_type":"text","content":{"text":{{summary}}},"task":{{taskName}},"finished":{{finishedAt}},"archiveBytes":{{archiveSize}},"files":{{selectedFileCount}},"success":{{succeeded}}}"#.into();
        let custom = hook_payload(&profile, &run).unwrap();
        assert_eq!(custom["task"], profile.name);
        assert_eq!(custom["finished"], local_finished);
        assert_eq!(custom["archiveBytes"], 1);
        assert_eq!(custom["files"], 1);
        assert_eq!(custom["success"], false);
        assert!(custom["content"]["text"].as_str().unwrap().contains("bad \"quote\""));
        let inline = render_hook_template(r#"{"message":"Task: {{taskName}}; {{error}}"}"#, &hook_template_values(&profile, Some(&run))).unwrap();
        assert_eq!(inline["message"], "Task: test \"quoted\" {{status}}; bad \"quote\"\nnext line");
        let old_syntax = render_hook_template(r#"{"task":{{json.taskName}}}"#, &hook_template_values(&profile, Some(&run))).unwrap();
        assert_eq!(old_syntax["task"], profile.name);
        let mut succeeded = run.clone();
        succeeded.status = "succeeded".into();
        succeeded.archive_size = None;
        succeeded.error = None;
        let success_body = hook_payload(&profile, &succeeded).unwrap();
        assert_eq!(success_body["success"], true);
        assert!(success_body["archiveBytes"].is_null());
        profile.hook_template = Some(DeploymentHookTemplate::Feishu);
        let success_card = hook_payload(&profile, &succeeded).unwrap();
        assert_eq!(success_card["card"]["header"]["template"], "green");
        assert!(success_card["card"]["header"]["title"]["content"].as_str().unwrap().contains("部署成功"));
        assert!(success_card["card"]["elements"][0]["text"]["content"].as_str().unwrap().contains("未打包"));
        assert!(render_hook_template("{\"x\":{{unknown}}}", &hook_template_values(&profile, Some(&run))).is_err());
        assert!(render_hook_template("{\"x\":{{status}}", &hook_template_values(&profile, Some(&run))).is_err());
        let mut legacy = serde_json::to_value(test_profile(Path::new("/tmp"))).unwrap();
        let fields = legacy.as_object_mut().unwrap();
        fields.remove("hookTemplate");
        fields.insert("hookMethod".into(), json!("PUT"));
        fields.insert("hookHeaders".into(), json!("{\"X-Test\":\"1\"}"));
        fields.insert("hookBody".into(), json!("legacy"));
        fields.insert("hookFormat".into(), json!("feishu"));
        let restored: DeploymentProfile = serde_json::from_value(legacy).unwrap();
        assert!(restored.hook_url.is_empty());
        assert_eq!(restored.hook_template, Some(DeploymentHookTemplate::Feishu));
        assert_eq!(restored.hook_body, "legacy");
        assert!(serde_json::to_value(restored).unwrap().get("hookMethod").is_none());
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

    #[test]
    fn hash_reports_every_byte_read() {
        let path = std::env::temp_dir().join(format!("luna-preview-progress-{}", Uuid::new_v4()));
        let contents = vec![42u8; 150_000];
        fs::write(&path, &contents).unwrap();
        let mut reported = 0;
        let (size, _) = sha256_file(&path, |count| reported += count).unwrap();
        assert_eq!(size, contents.len() as u64);
        assert_eq!(reported, size);
        fs::remove_file(path).unwrap();
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
        assert_eq!(profile.shell, DeploymentShell::Bash);
    }

    #[test]
    fn legacy_sh_profile_runs_and_saves_as_bash() {
        let profile: DeploymentProfile = serde_json::from_value(json!({"id": Uuid::new_v4().to_string(), "bookmarkId": "b", "name": "old", "workspace": "/tmp/old", "remoteDirectory": "/srv", "shell": "sh"})).unwrap();
        assert_eq!(profile.shell, DeploymentShell::Bash);
        assert_eq!(serde_json::to_value(profile).unwrap()["shell"], "bash");
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
        assert!(build_zip(&snapshot, &archive, &[file], &AtomicBool::new(false), None).unwrap() > 0);
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
        assert!(build_tar_gz(&snapshot, &archive, &[file], &AtomicBool::new(false), None).unwrap() > 0);
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
        assert!(command.contains("UPLOAD_DIR='/srv/space '\\''中文'"));
        assert!(command.contains(&format!("FILE_NAME='{archive}'")));
        assert!(command.contains(&format!("FILE_PATH='/srv/space '\\''中文/{archive}'")));
        assert!(command.contains(&format!("LUNA_FILE_NAME='{archive}'")));
        assert!(command.contains(&format!("LUNA_FILE_PATH='/srv/space '\\''中文/{archive}'")));
        assert!(command.contains(r#"bash -lc 'ls "${LUNA_FILE_PATH}"'"#));
        assert!(!command.contains("staging"));
        profile.shell_template = "ls {{FILE_PATH}} && printf '%s' '{{FILE_NAME}}'".into();
        let command = shell_command(&profile, &files, Some(archive));
        assert!(command.contains("ls \"${FILE_PATH}\""));
        assert!(command.contains("printf"));
        assert!(command.contains("\"${FILE_NAME}\""));
        assert!(!command.contains("{{FILE_PATH}}"));

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
