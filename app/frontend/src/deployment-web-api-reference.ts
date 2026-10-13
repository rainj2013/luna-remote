export interface WebApiEndpointReference {
  method: 'GET' | 'POST'
  path: string
  descriptionZh: string
  descriptionEn: string
  request: string
  response: string
  types?: string
  noteZh?: string
  noteEn?: string
}

const summaryType = `type DeploymentSummary = {
  id: string
  bookmarkId: string
  name: string
  remoteDirectory: string // upload destination directory
  archiveEnabled: boolean
  schedule: { enabled: boolean; dailyTime: string } // HH:mm
}`

const profileType = `type DeploymentProfile = {
  id: string
  bookmarkId: string
  name: string
  workspace: string
  selection: { included: string[]; excluded: string[] }
  remoteDirectory: string // upload destination directory
  archiveEnabled: boolean
  archiveFormat: 'zip' | 'tarGz'
  shellTemplate: string
  shell: 'bash'
  confirmManual: boolean
  schedule: { enabled: boolean; dailyTime: string }
  hookUrl: string
  hookTemplate: 'custom' | 'feishu' | null
  hookBody: string
}`

const runType = `type DeploymentRun = {
  id: string
  deploymentId: string
  bookmarkId: string
  triggerType: 'manual' | 'scheduled' | 'api'
  startedAt: string // RFC 3339
  finishedAt: string | null // RFC 3339
  status: 'draft' | 'preparing' | 'packaging' | 'uploading' | 'executing-command' | 'awaiting-confirmation' | 'succeeded' | 'failed' | 'cancelled'
  selectedFileCount: number
  archiveEnabled: boolean
  archiveSize: number | null // bytes
  manifestSha256: string | null
  remoteDestinationDir: string
  commandExitCode: number | null
  stdout: string
  stderr: string
  error: string | null
  manifest: string | null
  commandLine: string
  hookError: string | null
}`

export const webApiEndpoints: WebApiEndpointReference[] = [
  {
    method: 'GET', path: '/deployments', descriptionZh: '查询部署任务列表', descriptionEn: 'List deployment tasks',
    request: 'Query: bookmarkId?: string\nBody: none',
    response: 'HTTP 200\n{ "items": DeploymentSummary[] }', types: summaryType,
  },
  {
    method: 'GET', path: '/deployments/{id}', descriptionZh: '查询部署任务详情', descriptionEn: 'Get deployment task details',
    request: 'Path: id: string (deployment task ID)\nBody: none',
    response: 'HTTP 200\nDeploymentProfile', types: profileType,
  },
  {
    method: 'GET', path: '/deployments/{id}/runs', descriptionZh: '查询指定任务的部署记录', descriptionEn: 'List runs for a task',
    request: 'Path: id: string (deployment task ID)\nBody: none',
    response: 'HTTP 200\n{ "items": DeploymentRun[] }', types: runType,
    noteZh: '按开始时间倒序，最多 500 条；列表中的 stdout、stderr 为空字符串，manifest 为 null',
    noteEn: 'Newest first, up to 500; stdout and stderr are empty strings and manifest is null in list results',
  },
  {
    method: 'GET', path: '/runs', descriptionZh: '查询所有部署记录', descriptionEn: 'List recent runs across tasks',
    request: 'Body: none',
    response: 'HTTP 200\n{ "items": DeploymentRun[] }', types: runType,
    noteZh: '按开始时间倒序，最多 500 条；列表中的 stdout、stderr 为空字符串，manifest 为 null',
    noteEn: 'Newest first, up to 500; stdout and stderr are empty strings and manifest is null in list results',
  },
  {
    method: 'GET', path: '/runs/{id}', descriptionZh: '查询部署记录详情', descriptionEn: 'Get full run details',
    request: 'Path: id: string (run ID)\nBody: none',
    response: 'HTTP 200\nDeploymentRun', types: runType,
  },
  {
    method: 'POST', path: '/deployments/{id}/runs', descriptionZh: '触发部署任务', descriptionEn: 'Trigger a deployment task',
    request: 'Path: id: string (deployment task ID)\nBody: none',
    response: 'HTTP 202 Accepted\n{ "runId": string, "statusUrl": string }',
    noteZh: '异步执行；用 GET /runs/{runId} 查询状态。终态为 succeeded、failed 或 cancelled',
    noteEn: 'Runs asynchronously; poll GET /runs/{runId}. Terminal states are succeeded, failed, and cancelled',
  },
]

export function formatWebApiEndpoint(endpoint: WebApiEndpointReference, chinese: boolean, baseUrl?: string): string {
  const description = chinese ? endpoint.descriptionZh : endpoint.descriptionEn
  const note = chinese ? endpoint.noteZh : endpoint.noteEn
  return [
    `${endpoint.method} /api/v1${endpoint.path} — ${description}`,
    baseUrl ? `Base URL: ${baseUrl}` : undefined,
    `Authorization: Bearer <token>`,
    `${chinese ? '请求' : 'Request'}:\n${endpoint.request}`,
    `${chinese ? '响应' : 'Response'}:\n${endpoint.response}`,
    endpoint.types,
    note ? `${chinese ? '说明' : 'Note'}: ${note}` : undefined,
  ].filter(Boolean).join('\n\n')
}

export function formatWebApiReference(baseUrl: string, chinese: boolean): string {
  const header = [
    'Luna Remote Deployment Web API',
    `Base URL: ${baseUrl}`,
    'Authorization: Bearer <token>',
    chinese ? '错误响应: HTTP 400 / 401 / 404 等，{ "error": string }' : 'Error response: HTTP 400 / 401 / 404, { "error": string }',
  ].join('\n')
  return `${header}\n\n${webApiEndpoints.map((endpoint) => formatWebApiEndpoint(endpoint, chinese)).join('\n\n---\n\n')}`
}
