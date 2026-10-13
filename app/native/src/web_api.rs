use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State as TauriState;
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

use crate::{commands::AppState, database::Database, deployment::DeploymentManager};

const SETTINGS_KEY: &str = "deploymentWebApi";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebApiConfig {
    pub enabled: bool,
    pub port: u16,
    #[serde(default)]
    pub allow_remote: bool,
}

impl Default for WebApiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 39647,
            allow_remote: false,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebApiStatus {
    config: WebApiConfig,
    running: bool,
    token: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct Runtime {
    config: Option<WebApiConfig>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
    error: Option<String>,
}

pub struct WebApiManager {
    db: Arc<Database>,
    deployments: Arc<DeploymentManager>,
    runtime: Mutex<Runtime>,
}

#[derive(Clone)]
struct ApiState {
    db: Arc<Database>,
    deployments: Arc<DeploymentManager>,
    token: String,
}

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn bad_request(error: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, error.into())
}
fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "资源不存在".into())
}

fn validate(config: &WebApiConfig) -> Result<(), String> {
    if config.port == 0 {
        return Err("Web API 端口必须在 1–65535 之间".into());
    }
    Ok(())
}

impl WebApiManager {
    pub fn new(db: Arc<Database>, deployments: Arc<DeploymentManager>) -> Arc<Self> {
        Arc::new(Self {
            db,
            deployments,
            runtime: Mutex::new(Runtime::default()),
        })
    }

    pub async fn status(&self) -> WebApiStatus {
        let runtime = self.runtime.lock().await;
        WebApiStatus {
            config: self.db.get_setting(SETTINGS_KEY, WebApiConfig::default()),
            running: runtime.shutdown.is_some(),
            token: self.db.get_deployment_web_api_token(),
            error: runtime.error.clone(),
        }
    }

    pub async fn start_saved(&self) {
        let config = self.db.get_setting(SETTINGS_KEY, WebApiConfig::default());
        if config.enabled {
            if let Err(error) = self.apply(config, false).await {
                self.runtime.lock().await.error = Some(error);
            }
        }
    }

    pub async fn apply(&self, config: WebApiConfig, persist: bool) -> Result<WebApiStatus, String> {
        validate(&config)?;
        let mut runtime = self.runtime.lock().await;
        if runtime.config.as_ref() == Some(&config) && runtime.shutdown.is_some() {
            drop(runtime);
            return Ok(self.status().await);
        }
        stop_runtime(&mut runtime).await;
        runtime.config = None;
        runtime.error = None;
        if config.enabled {
            let token = match self.db.get_deployment_web_api_token() {
                Some(value) if !value.is_empty() => value,
                _ => {
                    let value = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                    self.db.save_deployment_web_api_token(&value)?;
                    value
                }
            };
            let address = SocketAddr::new(
                IpAddr::V4(if config.allow_remote {
                    Ipv4Addr::UNSPECIFIED
                } else {
                    Ipv4Addr::LOCALHOST
                }),
                config.port,
            );
            let listener = tokio::net::TcpListener::bind(address)
                .await
                .map_err(|error| {
                    let message = format!("Web API 无法监听 {address}：{error}");
                    runtime.error = Some(message.clone());
                    message
                })?;
            let state = ApiState {
                db: self.db.clone(),
                deployments: self.deployments.clone(),
                token,
            };
            let routes = Router::new()
                .route("/api/v1/deployments", get(list_deployments))
                .route("/api/v1/deployments/{id}", get(get_deployment))
                .route(
                    "/api/v1/deployments/{id}/runs",
                    get(list_runs).post(trigger_run),
                )
                .route("/api/v1/runs", get(list_all_runs))
                .route("/api/v1/runs/{id}", get(get_run))
                .with_state(state.clone())
                .layer(middleware::from_fn_with_state(state, authorize));
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            runtime.task = Some(tokio::spawn(async move {
                let _ = axum::serve(listener, routes)
                    .with_graceful_shutdown(async {
                        let _ = shutdown_rx.await;
                    })
                    .await;
            }));
            runtime.shutdown = Some(shutdown_tx);
        }
        if persist {
            if let Err(error) = self.db.set_setting(SETTINGS_KEY, &config) {
                stop_runtime(&mut runtime).await;
                return Err(error);
            }
        }
        runtime.config = Some(config);
        drop(runtime);
        Ok(self.status().await)
    }

    pub async fn regenerate_token(&self) -> Result<WebApiStatus, String> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.db.save_deployment_web_api_token(&token)?;
        let config = self.db.get_setting(SETTINGS_KEY, WebApiConfig::default());
        let mut runtime = self.runtime.lock().await;
        stop_runtime(&mut runtime).await;
        runtime.config = None;
        drop(runtime);
        self.apply(config, false).await
    }
}

async fn stop_runtime(runtime: &mut Runtime) {
    if let Some(shutdown) = runtime.shutdown.take() {
        let _ = shutdown.send(());
    }
    if let Some(mut task) = runtime.task.take() {
        if tokio::time::timeout(std::time::Duration::from_secs(2), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
}

async fn authorize(
    State(state): State<ApiState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        add_cors(&mut response, origin.as_deref());
        if request
            .headers()
            .get("access-control-request-private-network")
            .and_then(|value| value.to_str().ok())
            == Some("true")
        {
            response.headers_mut().insert(
                "access-control-allow-private-network",
                HeaderValue::from_static("true"),
            );
        }
        return response;
    }
    let expected = format!("Bearer {}", state.token);
    if request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(expected.as_str())
    {
        let mut response =
            ApiError(StatusCode::UNAUTHORIZED, "缺少或无效的 Bearer Token".into()).into_response();
        add_cors(&mut response, origin.as_deref());
        return response;
    }
    let mut response = next.run(request).await;
    add_cors(&mut response, origin.as_deref());
    response
}

fn add_cors(response: &mut Response, origin: Option<&str>) {
    if let Some(origin) = origin.and_then(|value| HeaderValue::from_str(value).ok()) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Authorization, Content-Type"),
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    bookmark_id: Option<String>,
}

async fn list_deployments(
    State(state): State<ApiState>,
    Query(query): Query<ListQuery>,
) -> Json<serde_json::Value> {
    let items = match query.bookmark_id {
        Some(id) => state.deployments.list(&id),
        None => state.deployments.list_all(),
    };
    Json(json!({ "items": items.into_iter().map(|item| json!({
        "id": item.id,
        "bookmarkId": item.bookmark_id,
        "name": item.name,
        "remoteDirectory": item.remote_directory,
        "archiveEnabled": item.archive_enabled,
        "schedule": item.schedule,
    })).collect::<Vec<_>>() }))
}

async fn get_deployment(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .deployments
        .get(&id)
        .map(|item| Json(json!(item)))
        .map_err(|_| not_found())
}

async fn list_runs(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.deployments.get(&id).map_err(|_| not_found())?;
    let items = state.db.list_deployment_runs(&id).map_err(bad_request)?;
    Ok(Json(json!({ "items": items })))
}

async fn list_all_runs(State(state): State<ApiState>) -> Result<Json<serde_json::Value>, ApiError> {
    let items = state.db.list_all_deployment_runs().map_err(bad_request)?;
    Ok(Json(json!({ "items": items })))
}

async fn get_run(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .db
        .get_deployment_run(&id)
        .map_err(bad_request)?
        .map(|run| Json(json!(run)))
        .ok_or_else(not_found)
}

async fn trigger_run(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    state.deployments.get(&id).map_err(|_| not_found())?;
    let run_id = Uuid::new_v4().to_string();
    let (created_tx, created_rx) = oneshot::channel();
    let deployments = state.deployments.clone();
    let execute_id = id.clone();
    let execute_run_id = run_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        deployments
            .execute_with_trigger(
                execute_id,
                None,
                false,
                true,
                None,
                None,
                execute_run_id,
                Some(created_tx),
            )
            .await
    });
    if created_rx.await.is_err() {
        return Err(bad_request(match task.await {
            Ok(Err(error)) => error,
            Ok(Ok(_)) => "无法创建部署记录".into(),
            Err(error) => error.to_string(),
        }));
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "runId": run_id, "statusUrl": format!("/api/v1/runs/{run_id}") })),
    ))
}

#[tauri::command]
pub async fn web_api_get(state: TauriState<'_, AppState>) -> Result<WebApiStatus, String> {
    Ok(state.web_api.status().await)
}

#[tauri::command]
pub async fn web_api_save(
    state: TauriState<'_, AppState>,
    config: WebApiConfig,
) -> Result<WebApiStatus, String> {
    state.web_api.apply(config, true).await
}

#[tauri::command]
pub async fn web_api_regenerate_token(
    state: TauriState<'_, AppState>,
) -> Result<WebApiStatus, String> {
    state.web_api.regenerate_token().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_origin_receives_cors_headers_without_configuration() {
        let mut response = StatusCode::OK.into_response();
        add_cors(&mut response, Some("https://example.com"));
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "https://example.com"
        );
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_HEADERS).unwrap(),
            "Authorization, Content-Type"
        );
    }

    #[test]
    fn api_is_off_and_local_by_default() {
        let config = WebApiConfig::default();
        assert!(!config.enabled);
        assert!(!config.allow_remote);
        assert_eq!(config.port, 39647);
        assert!(validate(&WebApiConfig { port: 0, ..config }).is_err());
    }
}
