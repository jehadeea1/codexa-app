export type ThemeMode = 'dark' | 'light';
export type WorkspacePanel = 'files' | 'editor' | 'preview';

export interface ProjectFile {
  path: string;
  content: string;
  languageOverride?: string | null;
  updatedAt: number;
}

export interface AndroidIdentity {
  appName: string;
  packageId: string;
  iconName: string;
  iconBackground: string;
  iconForeground: string;
  iconShape: 'rounded' | 'circle' | 'squircle';
  allowExternalNetwork: boolean;
  uploadedIcon?: string;
}

export interface CodeProject {
  id: string;
  name: string;
  files: Record<string, ProjectFile>;
  entry: string;
  android: AndroidIdentity;
  createdAt: number;
  updatedAt: number;
}

export interface FileTemplate {
  id: string;
  label: string;
  extension: string;
  language: string;
  category: string;
  icon: string;
  starter: string;
}

export interface PreviewResult {
  html: string;
  title: string;
  diagnostics: string[];
  kind?: 'frame' | 'source';
  language?: string;
  source?: string;
}
