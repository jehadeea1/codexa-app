export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('تعذر قراءة الملف.')));
    reader.addEventListener('error', () => reject(new Error('تعذر قراءة الملف.')));
    reader.readAsDataURL(file);
  });
}

export function extensionOf(path: string): string {
  const filename = path.split('/').at(-1) ?? path;
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function isTextFile(path: string): boolean {
  return /^(?:html?|css|[cm]?js|[cm]?ts|jsx|tsx|jsonc?|md|markdown|xml|svg|ya?ml|toml|ini|txt|log|py|pyw|java|kt|kts|c|h|cc|cpp|cxx|hpp|hh|cs|go|rs|sql|sh|bash|zsh|php|rb|r|swift|dart|vue|svelte|astro|gradle|properties|env\.example|gitignore|dockerfile)$/i.test(extensionOf(path)) || !extensionOf(path);
}

export async function fileTextOrDataUrl(file: File): Promise<string> {
  if (isTextFile(file.name)) return file.text();
  if (file.size > 2 * 1024 * 1024) throw new Error(`الملف ${file.name} أكبر من الحد المسموح للاستيراد.`);
  return fileAsDataUrl(file);
}

export function safeFilename(input: string): string {
  return input.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').slice(0, 80);
}
