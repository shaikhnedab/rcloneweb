import type * as Gen from './generator';

export type Tab = 'dashboard' | 'builder' | 'script' | 'run' | 'schedule' | 'install' | 'webhook' | 'settings';

export type ScriptDoc = {
  id: string; name: string; createdAt?: string; updatedAt?: string | null;
  rawToken?: string; cronExpr?: string; sourceVpsId?: string | null; destFleetId?: string | null;
  manualEdited?: boolean; script?: string; config?: Gen.AppConfig;
};
export type ScriptSummary = { id: string; name: string; updatedAt: string };
export type FleetItem = { id: string; name: string; host: string; port: number; user: string; auth: string; hasPassword: boolean; lastSeen: string | null };
export type DestItem = {
  id: string; name: string; type: string; host: string; port: string; user: string;
  remoteName: string; remotePath: string; sftpAuth: string; keyPath?: string; hasPassword: boolean; hasSecret: boolean;
  s3Provider: string; s3Bucket: string; s3Region: string; s3Endpoint: string; lastSeen: string | null;
};
export type RunRec = {
  id: string; scriptId: string; vpsId: string; vpsName: string; name: string;
  dryRun: boolean; startedAt: string; finishedAt: string | null; exitCode: number | null;
  bytes?: number; output?: string; // `output` only exists on pre-2.1 records
};
export type ScheduleDoc = { id: string; scriptId: string; vpsId: string; cronExpr: string; timezone: string; enabled: boolean; createdAt: string; lastRun: string | null };
export type BrowseEntry = { name: string; path: string; isDir: boolean; isParent?: boolean };
export type BrowseState = {
  kind: 'src' | 'dest' | 'include' | 'exclude';
  rowIdx: number;
  mode: 'vps' | 'remote' | 'remoteFleet';
  vpsId?: string;
  destId?: string;
  remoteCfg?: Record<string, string>;
  path: string;
  entries: BrowseEntry[];
  hint: string;
  selected: string[];
};
