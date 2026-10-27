use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::{commands::AppState, database::Database};

const SAVED_COMMANDS_KEY: &str = "savedCommands";
const SAVED_COMMANDS_LIMIT: usize = 500;
const COMMAND_MAX_CHARS: usize = 20_000;
const NAME_MAX_CHARS: usize = 80;
const GROUP_MAX_CHARS: usize = 40;
const DESCRIPTION_MAX_CHARS: usize = 500;
const DERIVED_NAME_MAX_CHARS: usize = 48;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: String,
    pub group: String,
    pub use_count: u32,
    pub last_used_at: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommandInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub group: String,
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut characters = value.chars();
    let truncated: String = characters.by_ref().take(max_chars).collect();
    if characters.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

/// Derives a readable title from the first non-empty line of a command.
fn derived_name(command: &str) -> String {
    let first_line = command
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    if first_line.is_empty() {
        "未命名命令".to_string()
    } else {
        truncate(first_line, DERIVED_NAME_MAX_CHARS)
    }
}

fn read_all(db: &Database) -> Vec<SavedCommand> {
    db.get_setting(SAVED_COMMANDS_KEY, Vec::new())
}

fn write_all(db: &Database, items: &[SavedCommand]) -> Result<(), String> {
    db.set_setting(SAVED_COMMANDS_KEY, &items.to_vec())
}

fn normalize(input: SavedCommandInput) -> Result<SavedCommandInput, String> {
    let command = input.command.trim().to_string();
    if command.is_empty() {
        return Err("命令内容不能为空".into());
    }
    if command.chars().count() > COMMAND_MAX_CHARS {
        return Err(format!("命令内容过长，最多 {COMMAND_MAX_CHARS} 个字符"));
    }
    let name = input.name.trim();
    let name = if name.is_empty() { derived_name(&command) } else { truncate(name, NAME_MAX_CHARS) };
    Ok(SavedCommandInput {
        id: input.id.filter(|id| !id.is_empty()),
        name,
        command,
        description: truncate(input.description.trim(), DESCRIPTION_MAX_CHARS),
        group: truncate(input.group.trim(), GROUP_MAX_CHARS),
    })
}

fn save(db: &Database, input: SavedCommandInput) -> Result<SavedCommand, String> {
    let input = normalize(input)?;
    let now = Utc::now().to_rfc3339();
    let mut items = read_all(db);
    let existing = input
        .id
        .as_ref()
        .and_then(|id| items.iter().find(|item| &item.id == id).cloned());
    if existing.is_none() && items.len() >= SAVED_COMMANDS_LIMIT {
        return Err(format!("最多只能保存 {SAVED_COMMANDS_LIMIT} 条常用命令"));
    }
    let saved = SavedCommand {
        id: existing
            .as_ref()
            .map(|item| item.id.clone())
            .or(input.id)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        name: input.name,
        command: input.command,
        description: input.description,
        group: input.group,
        use_count: existing.as_ref().map(|item| item.use_count).unwrap_or(0),
        last_used_at: existing
            .as_ref()
            .map(|item| item.last_used_at.clone())
            .unwrap_or_default(),
        created_at: existing
            .map(|item| item.created_at)
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };
    items.retain(|item| item.id != saved.id);
    items.insert(0, saved.clone());
    write_all(db, &items)?;
    Ok(saved)
}

fn remove(db: &Database, id: &str) -> Result<(), String> {
    let mut items = read_all(db);
    items.retain(|item| item.id != id);
    write_all(db, &items)
}

fn touch(db: &Database, id: &str) -> Result<SavedCommand, String> {
    let mut items = read_all(db);
    let item = items
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| "常用命令不存在".to_string())?;
    item.use_count = item.use_count.saturating_add(1);
    item.last_used_at = Utc::now().to_rfc3339();
    let updated = item.clone();
    write_all(db, &items)?;
    Ok(updated)
}

#[tauri::command]
pub fn saved_commands_list(state: State<AppState>) -> Vec<SavedCommand> {
    read_all(&state.db)
}

#[tauri::command]
pub fn saved_commands_save(
    state: State<AppState>,
    input: SavedCommandInput,
) -> Result<SavedCommand, String> {
    save(&state.db, input)
}

#[tauri::command]
pub fn saved_commands_remove(state: State<AppState>, id: String) -> Result<(), String> {
    remove(&state.db, &id)
}

#[tauri::command]
pub fn saved_commands_touch(state: State<AppState>, id: String) -> Result<SavedCommand, String> {
    touch(&state.db, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Database {
        let path = std::env::temp_dir().join(format!("luna-saved-commands-{}.db", Uuid::new_v4()));
        Database::open(&path, "luna-saved-commands-test").unwrap()
    }

    #[test]
    fn derives_name_from_first_command_line() {
        assert_eq!(derived_name("\n  \n  df -h  \nsort"), "df -h");
        assert_eq!(derived_name(""), "未命名命令");
        let long = "a".repeat(DERIVED_NAME_MAX_CHARS + 5);
        assert_eq!(derived_name(&long).chars().count(), DERIVED_NAME_MAX_CHARS + 1);
        assert!(derived_name(&long).ends_with('…'));
    }

    #[test]
    fn saves_and_orders_newest_first() {
        let db = database();
        let first = save(&db, SavedCommandInput { id: None, name: "磁盘".into(), command: "df -h".into(), description: String::new(), group: "运维".into() }).unwrap();
        let second = save(&db, SavedCommandInput { id: None, name: String::new(), command: "docker ps".into(), description: String::new(), group: String::new() }).unwrap();
        let items = read_all(&db);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, second.id);
        assert_eq!(items[1].id, first.id);
        assert_eq!(second.name, "docker ps");
        assert_eq!(second.use_count, 0);
    }

    #[test]
    fn keeps_creation_time_and_count_when_updating() {
        let db = database();
        let created = save(&db, SavedCommandInput { id: None, name: "日志".into(), command: "tail -f app.log".into(), description: String::new(), group: String::new() }).unwrap();
        touch(&db, &created.id).unwrap();
        touch(&db, &created.id).unwrap();
        let updated = save(&db, SavedCommandInput { id: Some(created.id.clone()), name: "日志跟踪".into(), command: "tail -n 200 app.log".into(), description: "只看最后 200 行".into(), group: String::new() }).unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.created_at, created.created_at);
        assert_eq!(updated.use_count, 2);
        assert_eq!(updated.name, "日志跟踪");
        assert_eq!(read_all(&db).len(), 1);
    }

    #[test]
    fn rejects_blank_commands_and_removes_entries() {
        let db = database();
        assert!(save(&db, SavedCommandInput { id: None, name: "空".into(), command: "   ".into(), description: String::new(), group: String::new() }).is_err());
        let item = save(&db, SavedCommandInput { id: None, name: "内存".into(), command: "free -m".into(), description: String::new(), group: String::new() }).unwrap();
        remove(&db, &item.id).unwrap();
        assert!(read_all(&db).is_empty());
        assert!(touch(&db, &item.id).is_err());
    }
}
