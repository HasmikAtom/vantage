export interface SystemInfo {
  hostname: string;
  fingerprint: string;
  os: string;
  kernel: string;
  cpuModel: string;
  cpuClock: string;
  cpuCores: number;          // logical CPUs = threads on SMT/HT systems
  cpuPhysicalCores: number;  // silicon execution units; equals cpuCores when SMT is off
  uptimeText: string;
  uptimeDays: number;
  bootedAt: string;
  timeText: string;
  loadAvg: [number, number, number];
}

export interface CpuHeadline {
  pct: number;
  user: number;
  system: number;
  idle: number;
  iowait: number;
  ctxSwitch: number;
  interrupts: number;
  softInt: number;
  temp: number;
  powerW: number;
}

export interface PCIeLink {
  currentSpeed: string;
  currentWidth: number;
  maxSpeed: string;
  maxWidth: number;
}

export interface GPUProcess {
  pid: number;
  name: string;
  device: string;
}

export interface GpuHeadline {
  name: string;
  driver: string;
  pct: number;
  vram: { used: number; total: number; unit: string };
  temp: number;
  fan: number;
  powerW: number;
  voltageV: number;
  coreMhz: number;
  memMhz: number;
  pstate: string;
  pcie: PCIeLink;
  processes: GPUProcess[];
}

export interface MemHeadline {
  pct: number;
  total: number;
  used: number;
  free: number;
  active: number;
  inactive: number;
  buffers: number;
  cached: number;
  unit: string;
  powerW: number;
}

export interface SwapHeadline {
  pct: number;
  total: number;
  used: number;
  free: number;
  unit: string;
}

export interface Headline {
  cpu: CpuHeadline;
  gpu: GpuHeadline;
  mem: MemHeadline;
  swap: SwapHeadline;
  cpuSpark: number[];
  gpuSpark: number[];
  memSpark: number[];
  storageSpark: number[];
}

export interface Sensor {
  id: string;
  label: string;
  group: string;
  value: number;
  unit: string;
  max: number;
  history: number[];
}

export interface Smart {
  passed: boolean;
  reallocated: number;
  pending: number;
  lifeLeft: number;
}

export interface SmartAttr {
  id: number;
  name: string;
  value: number;
  worst: number;
  threshold: number;
  rawValue: number;
  rawString: string;
  prefailure: boolean;
  whenFailed: string;
}

export interface NvmeHealthLog {
  criticalWarning: number;
  temperature: number;
  availableSpare: number;
  availableSpareThreshold: number;
  percentageUsed: number;
  dataUnitsRead: number;
  dataUnitsWritten: number;
  hostReads: number;
  hostWrites: number;
  controllerBusyTime: number;
  powerCycles: number;
  powerOnHours: number;
  unsafeShutdowns: number;
  mediaErrors: number;
  numErrLogEntries: number;
  warningTempTime: number;
  criticalCompTime: number;
  temperatureSensors: number[];
}

export interface ScrutinyScore {
  rating: 'healthy' | 'warning' | 'failed';
  reasons: string[];
}

export interface SmartDetail {
  serial: string;
  firmware: string;
  modelFamily: string;
  formFactor: string;
  rotationRate: number;
  interfaceSpeed: string;
  maxInterface: string;
  powerCycles: number;
  ataAttrs: SmartAttr[];
  nvmeLog: NvmeHealthLog | null;
  score: ScrutinyScore;
}

export interface Disk {
  id: string;
  label: string;
  model: string;
  mount: string;
  type: string;
  total: number;
  used: number;
  health: string;
  tempC: number;
  powerOnHours: number;
  writes: number;
  reads: number;
  smart: Smart;
  detail: SmartDetail | null;
}

export interface Filesystem {
  mount: string;
  fstype: string;
  used: number;
  total: number;
  unit: string;
}

export interface NetInterface {
  name: string;
  ip: string;
  rx: number;
  tx: number;
  status: string;
}

export interface Network {
  interfaces: NetInterface[];
  sparkline: number[];
}

export interface Tunnel {
  id: string;
  tunnelId?: string;
  tunnelName?: string;
  hostname: string;
  service: string;
  target: string;
  status: string;
  requests24h: number;
  latencyMs: number;
  origin: string;
}

export interface Container {
  id: string;
  name: string;
  status: string;
  uptime: string;
  cpu: number | null;
  mem: number | null;
  image: string;
  ports: string[];
  stack: string;            // compose project name, empty when container is non-compose
  stackWorkingDir: string;  // host path the compose file lives at; empty when non-compose
  stackConfigFiles: string; // comma-separated list of compose file paths (label-sourced)
}

export interface ContainerInspectState {
  status: string;
  running: boolean;
  paused: boolean;
  restarting: boolean;
  oomKilled: boolean;
  exitCode: number;
  error: string;
  startedAt: string;
  finishedAt: string;
  health?: string; // healthy | unhealthy | starting | omitted (no healthcheck)
  pid: number;
  restartCount: number;
}

export interface ContainerInspectConfig {
  cmd: string[];
  entrypoint: string[];
  env: string[]; // "KEY=value" pairs
  labels: Record<string, string>;
  workingDir: string;
  user: string;
  hostname: string;
}

export interface ContainerInspectHost {
  restartPolicy: string;
  networkMode: string;
  privileged: boolean;
  autoRemove: boolean;
  memoryLimit: number; // bytes, 0 = unlimited
  nanoCpus: number;    // 1e9 = 1 CPU, 0 = unlimited
}

export interface ContainerMount {
  type: string;        // bind | volume | tmpfs
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

export interface ContainerNetwork {
  ipAddress: string;
  gateway: string;
  macAddress: string;
  networkId: string;
}

export interface CreateContainerRequest {
  image: string;                       // required, e.g. "nginx:latest"
  name?: string;                       // optional, docker auto-generates if empty
  cmd?: string[];                      // overrides image CMD
  env?: string[];                      // "KEY=value" pairs
  ports?: PortMapping[];
  mounts?: VolumeMount[];
  restartPolicy?: '' | 'no' | 'on-failure' | 'always' | 'unless-stopped';
}

export interface PortMapping {
  hostPort: number;       // 0 = don't publish
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface VolumeMount {
  hostPath: string;       // host absolute path or named volume
  containerPath: string;
  readOnly: boolean;
}

export interface CreateContainerResponse {
  id: string;
  name: string;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Stacks (docker-compose)
// ---------------------------------------------------------------------------

export type StackKind = 'managed' | 'discovered';

export interface StackSummary {
  name: string;
  kind: StackKind;          // managed = we deployed it; discovered = label-only
  updatedAt: string;        // ISO-8601; empty for discovered
  workingDir?: string;      // discovered only — host path the compose file lives at
  containerCount: number;
  // True for managed (we own the file); for discovered, true iff the
  // labeled config_files path still exists on the host. Drives the
  // Edit-vs-Recreate UI affordance: file present → Edit can load YAML;
  // file gone → only Recreate is useful.
  hasFile: boolean;
}

export interface Stack {
  name: string;
  kind: StackKind;
  updatedAt: string;
  workingDir?: string;
  yaml: string;             // empty for discovered (we don't own the file)
  containers: Container[];
}

export interface StackCreateRequest {
  name: string;
  yaml: string;
}

export interface StackUpdateRequest {
  yaml: string;
}

// Reclaim — list rows shown in the per-card reclaim dialog. Distinct types
// per category so the dialog can render the right columns (tag/name/etc.)
// without ad-hoc unions.
export interface ReclaimableImage {
  id: string;
  repoTag: string; // "<none>" for dangling
  sizeBytes: number;
  createdAt: string;
}

export interface ReclaimableContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ReclaimableVolume {
  name: string;
  sizeBytes: number;
  createdAt: string; // may be "" on older docker
}

export interface ReclaimItemResult {
  id: string;
  status: 'ok' | 'skipped' | 'error';
  error?: string;
}

export interface ReclaimResult {
  items?: ReclaimItemResult[];
  freedBytes?: number; // populated only for build-cache
  successCount: number;
  skippedCount: number;
  errorCount: number;
}

export interface ContainerInspect {
  id: string;
  name: string;
  image: string;
  imageDigest: string;
  created: string;
  platform: string;
  driver: string;
  state: ContainerInspectState;
  config: ContainerInspectConfig;
  hostConfig: ContainerInspectHost;
  mounts: ContainerMount[];
  networks: Record<string, ContainerNetwork>;
}

export interface Service {
  name: string;
  status: string;
  enabled: boolean;
  pid: number | null;
  memMb: number;
  user: string;
  description: string;
}

export interface Port {
  port: number;
  proto: string;
  service: string;
  exposed: string;
  pid: number | null;
  process: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  user: string;
  cpu: number;
  memMb: number;
  cmd: string;
  threads: number;
}

export interface PressureLine {
  avg10: number;
  avg60: number;
  avg300: number;
}

export interface Pressure {
  cpu: PressureLine;
  memSome: PressureLine;
  memFull: PressureLine;
  ioSome: PressureLine;
  ioFull: PressureLine;
  available: boolean;
}

export interface CoreUsage {
  core: number;
  pct: number;
}

export interface DiskIO {
  id: string;
  readBps: number;
  writeBps: number;
  readIops: number;
  writeIops: number;
  utilPct: number;
}

export interface DockerDFCategory {
  count: number;
  active: number;
  sizeBytes: number;
  reclaimBytes: number;
}

export interface DockerDF {
  images: DockerDFCategory;
  containers: DockerDFCategory;
  volumes: DockerDFCategory;
  buildCache: DockerDFCategory;
}

export interface Connection {
  remoteIp: string;
  localPort: number;
  service: string;
  count: number;
}

export interface UpdateInfo {
  upgradableCount: number;
  securityCount: number;
  rebootRequired: boolean;
  rebootPkgs: string[];
  summary: string;
}

export interface JournalEntry {
  timestamp: string;
  unit: string;
  priority: number;
  message: string;
}

export interface User {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
  system: boolean;
  groups: string[];
}

export interface Group {
  name: string;
  gid: number;
  members: string[];
}

export interface UsersInfo {
  users: User[];
  groups: Group[];
}

export type FsEntryType = 'dir' | 'file' | 'symlink' | 'other';

export interface FsEntry {
  name: string;
  path: string;
  type: FsEntryType;
  size: number;
  mode: number;
  modeStr: string;
  owner: string;
  group: string;
  uid: number;
  gid: number;
  mtime: number;
  isSymlink?: boolean;
  target?: string;
  broken?: boolean;
}

export interface FsListResponse {
  path: string;
  parent: string;
  entries: FsEntry[];
}

export interface FsReadResponse {
  path: string;
  size: number;
  mode: number;
  mtime: number;
  content: string;
}

export interface WhitelistEntry {
  email: string;
  role: 'viewer' | 'operator' | 'admin';
  addedAt: number;          // unix ms
  addedBy: string;          // user id of the admin who added it
}

export interface TrashItem {
  id: string;
  originalPath: string;
  type: FsEntryType;
  size: number;
  deletedAt: number;
  deletedBy?: string;
}

export type FirewallDirection = 'in' | 'out';
export type FirewallAction = 'allow' | 'deny' | 'reject' | 'limit';

export interface FirewallRule {
  port: number;          // 0 = any
  portEnd?: number;      // when >0 the rule covers port..portEnd
  proto: string;         // 'tcp' | 'udp' | '' (any)
  direction: FirewallDirection;
  action: FirewallAction;
  from?: string;         // CIDR/IP/'Anywhere'
  to?: string;
  v6?: boolean;
  comment?: string;
  raw?: string;
}

export interface FirewallStatus {
  available: boolean;    // false = no supported backend on this server
  backend: string;       // 'ufw' etc.
  active: boolean;
  default?: string;
  rules: FirewallRule[];
}

export interface AlertEvent {
  id: string;            // stable: "<metric>:<beganAt-unix>"
  metric: string;        // "cpu" | "mem" | "swap" | "load" | "fs:/mnt" | "sensor:<id>"
  label: string;         // human label
  severity: 'warning' | 'critical';
  beganAt: string;       // RFC3339
  endedAt?: string;      // empty when still open
  threshold: number;
  peak: number;
  unit: string;          // "%" | "°C" | ""
}

export interface DashboardSnapshot {
  system: SystemInfo;
  headline: Headline;
  sensors: Sensor[];
  disks: Disk[];
  filesystems: Filesystem[];
  network: Network;
  tunnels: Tunnel[];
  containers: Container[];
  services: Service[];
  ports: Port[];
  processes: ProcessInfo[];
  cores: CoreUsage[];
  pressure: Pressure;
  diskIo: DiskIO[];
  dockerDf: DockerDF;
  connections: Connection[];
  updates: UpdateInfo;
  journal: JournalEntry[];
  users: UsersInfo;
  alerts: AlertEvent[];
}
