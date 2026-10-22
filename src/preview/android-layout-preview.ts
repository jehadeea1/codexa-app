const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const ROOT_LAYOUTS = new Set(['LinearLayout', 'FrameLayout', 'RelativeLayout', 'ConstraintLayout', 'ScrollView', 'HorizontalScrollView', 'CoordinatorLayout', 'DrawerLayout', 'layout', 'merge']);
const BUTTONS = new Set(['Button', 'ImageButton', 'MaterialButton', 'AppCompatButton']);
const TEXTS = new Set(['TextView', 'AppCompatTextView', 'MaterialTextView']);
const IMAGES = new Set(['ImageView', 'AppCompatImageView']);
const INPUTS = new Set(['EditText', 'TextInputEditText', 'AutoCompleteTextView', 'TextInputLayout']);
const CHOICES = new Set(['CheckBox', 'RadioButton', 'Switch', 'SwitchCompat', 'SwitchMaterial', 'ToggleButton']);
const CONTAINERS = new Set(['LinearLayout', 'FrameLayout', 'RelativeLayout', 'ConstraintLayout', 'ScrollView', 'HorizontalScrollView', 'CoordinatorLayout', 'DrawerLayout', 'ViewGroup', 'layout', 'merge']);

export interface AndroidLayoutPreview {
  html: string;
  title: string;
  diagnostics: string[];
}

type Resources = { strings: Map<string, string>; colors: Map<string, string> };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function localName(node: Element): string {
  const raw = node.localName || node.tagName.split(':').at(-1) || node.tagName;
  return raw.split('.').at(-1) || raw;
}

function attr(node: Element, name: string): string {
  return node.getAttributeNS(ANDROID_NS, name) || node.getAttribute(`android:${name}`) || node.getAttribute(name) || '';
}

function parseXml(source: string): Document | null {
  if (source.length > 512_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) return null;
  try {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    return doc.querySelector('parsererror') ? null : doc;
  } catch {
    return null;
  }
}

function loadResources(files: Record<string, { content: string }>): Resources {
  const strings = new Map<string, string>();
  const colors = new Map<string, string>();
  let parsed = 0;
  for (const [path, file] of Object.entries(files)) {
    if (!/(?:^|\/)res\/values(?:-[^/]+)?\/[^/]+\.xml$/i.test(path) || parsed >= 16) continue;
    const doc = parseXml(file.content);
    if (!doc || localName(doc.documentElement) !== 'resources') continue;
    parsed += 1;
    for (const child of [...doc.documentElement.children]) {
      const name = child.getAttribute('name');
      if (!name) continue;
      const value = child.textContent?.trim() ?? '';
      if (localName(child) === 'string' && value.length < 500) strings.set(name, value);
      if (localName(child) === 'color' && value.length < 40) colors.set(name, value);
    }
  }
  return { strings, colors };
}

function resolveString(value: string, resources: Resources): string {
  const match = value.match(/^@string\/([\w.]+)$/);
  return match ? (resources.strings.get(match[1]) ?? value) : value;
}

function toColor(input: string, resources: Resources): string | null {
  let value = input.trim();
  const ref = value.match(/^@color\/([\w.]+)$/);
  if (ref) value = resources.colors.get(ref[1]) ?? '';
  const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (!hex) return null;
  if (hex.length === 3) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  if (hex.length === 4) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  if (hex.length === 6) return `#${hex}`;
  if (hex.length === 8) {
    const alpha = Number.parseInt(hex.slice(0, 2), 16) / 255;
    return `rgba(${Number.parseInt(hex.slice(2, 4), 16)},${Number.parseInt(hex.slice(4, 6), 16)},${Number.parseInt(hex.slice(6, 8), 16)},${alpha.toFixed(3)})`;
  }
  return null;
}

function dimension(value: string, fallback: string): string {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'match_parent' || normalized === 'fill_parent') return '100%';
  if (normalized === 'wrap_content') return 'auto';
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)(dp|sp|px)?$/);
  if (!match) return fallback;
  const amount = Math.max(0, Math.min(1600, Number(match[1])));
  return `${amount}px`;
}

function spacing(value: string): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(?:dp|sp|px)?$/i);
  if (!match) return null;
  return `${Math.max(0, Math.min(160, Number(match[1])))}px`;
}

function drawableSource(value: string, files: Record<string, { content: string }>): string | null {
  const name = value.match(/^@drawable\/([\w.-]+)$/)?.[1];
  if (!name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const path = Object.keys(files).find((candidate) => new RegExp(`(?:^|/)res/drawable(?:-[^/]+)?/${escaped}\\.(?:png|jpe?g|webp|gif|svg)$`, 'i').test(candidate));
  if (!path) return null;
  const content = files[path].content;
  if (content.startsWith('data:image/')) return content;
  if (/\.svg$/i.test(path) && /^\s*<svg[\s>]/i.test(content)) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
  return null;
}

function childElements(element: Element): Element[] {
  return [...element.children].filter((child) => !['data', 'requestFocus'].includes(localName(child)));
}

function renderNode(element: Element, resources: Resources, files: Record<string, { content: string }>, depth: number, budget: { count: number }): string {
  if (depth > 28 || budget.count >= 500) return '<div class="ax-note">تجاوزت المعاينة الحد الآمن لتعشيق العناصر.</div>';
  budget.count += 1;
  const tag = localName(element);
  if (tag === 'layout' || tag === 'merge') return childElements(element).map((child) => renderNode(child, resources, files, depth + 1, budget)).join('');

  const hidden = attr(element, 'visibility') === 'gone' || attr(element, 'visibility') === 'invisible';
  if (hidden) return '';
  const width = dimension(attr(element, 'layout_width'), '100%');
  const height = dimension(attr(element, 'layout_height'), CONTAINERS.has(tag) ? 'auto' : 'wrap');
  const padding = spacing(attr(element, 'padding'));
  const margin = spacing(attr(element, 'layout_margin'));
  const marginTop = spacing(attr(element, 'layout_marginTop'));
  const marginBottom = spacing(attr(element, 'layout_marginBottom'));
  const marginStart = spacing(attr(element, 'layout_marginStart') || attr(element, 'layout_marginLeft'));
  const marginEnd = spacing(attr(element, 'layout_marginEnd') || attr(element, 'layout_marginRight'));
  const style: string[] = [`width:${width}`, `min-height:${height === 'auto' || height === 'wrap' ? '0' : height}`];
  if (height !== 'auto' && height !== 'wrap') style.push(`height:${height}`);
  if (padding) style.push(`padding:${padding}`);
  if (margin) style.push(`margin:${margin}`);
  if (marginTop) style.push(`margin-top:${marginTop}`);
  if (marginBottom) style.push(`margin-bottom:${marginBottom}`);
  if (marginStart) style.push(`margin-inline-start:${marginStart}`);
  if (marginEnd) style.push(`margin-inline-end:${marginEnd}`);
  const background = toColor(attr(element, 'background'), resources);
  if (background) style.push(`background:${background}`);

  const gravity = attr(element, 'gravity') || attr(element, 'layout_gravity');
  const center = gravity.includes('center');
  if (center) { style.push('align-items:center', 'justify-content:center'); }
  else if (/end|right|bottom/.test(gravity)) style.push('align-items:flex-end');
  else if (/start|left|top/.test(gravity)) style.push('align-items:flex-start');

  if (CONTAINERS.has(tag) || childElements(element).length) {
    const orientation = attr(element, 'orientation') || 'vertical';
    const children = childElements(element).map((child) => renderNode(child, resources, files, depth + 1, budget)).join('');
    const scroll = tag === 'ScrollView' || tag === 'HorizontalScrollView';
    const classes = ['ax-node', 'ax-container', tag === 'FrameLayout' ? 'ax-frame' : '', tag === 'LinearLayout' && orientation === 'horizontal' ? 'ax-row' : '', tag === 'ConstraintLayout' || tag === 'RelativeLayout' ? 'ax-stack' : '', scroll ? 'ax-scroll' : ''].filter(Boolean).join(' ');
    return `<div class="${classes}" style="${style.join(';')}">${children || (tag === 'LinearLayout' ? '<div class="ax-empty">LinearLayout</div>' : '')}</div>`;
  }

  if (TEXTS.has(tag)) {
    const text = escapeHtml(resolveString(attr(element, 'text') || attr(element, 'hint') || 'نص تجريبي', resources));
    const size = dimension(attr(element, 'textSize'), '16px');
    const color = toColor(attr(element, 'textColor'), resources);
    const weight = (attr(element, 'textStyle') || '').includes('bold') ? '700' : '400';
    const gravityCss = gravity.includes('center') ? 'text-align:center;' : /right|end/.test(gravity) ? 'text-align:right;' : '';
    return `<div class="ax-node ax-text" style="${style.join(';')};font-size:${size};font-weight:${weight};${color ? `color:${color};` : ''}${gravityCss}">${text}</div>`;
  }
  if (BUTTONS.has(tag)) {
    const text = escapeHtml(resolveString(attr(element, 'text') || (tag === 'ImageButton' ? 'زر أيقونة' : 'زر'), resources));
    const tint = toColor(attr(element, 'backgroundTint'), resources);
    return `<div class="ax-node ax-button-wrap" style="${style.join(';')}"><button class="ax-button" type="button" disabled${tint ? ` style="background:${tint}"` : ''}>${text}</button></div>`;
  }
  if (IMAGES.has(tag)) {
    const source = drawableSource(attr(element, 'src') || attr(element, 'srcCompat'), files);
    return `<div class="ax-node ax-image" style="${style.join(';')}">${source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(resolveString(attr(element, 'contentDescription'), resources) || 'صورة Android')}"/>` : '<span>صورة</span>'}</div>`;
  }
  if (INPUTS.has(tag)) {
    const value = escapeHtml(resolveString(attr(element, 'text'), resources));
    const hint = escapeHtml(resolveString(attr(element, 'hint') || 'اكتب هنا…', resources));
    return `<div class="ax-node ax-input-wrap" style="${style.join(';')}"><input aria-label="${hint}" placeholder="${hint}" value="${value}" readonly/></div>`;
  }
  if (CHOICES.has(tag)) {
    const text = escapeHtml(resolveString(attr(element, 'text') || tag, resources));
    return `<div class="ax-node ax-choice" style="${style.join(';')}"><span class="ax-choice-dot"></span><span>${text}</span></div>`;
  }
  if (tag === 'ProgressBar') return `<div class="ax-node ax-progress" style="${style.join(';')}"><span></span></div>`;
  if (tag === 'Space') return `<div class="ax-node ax-space" style="${style.join(';')}"></div>`;
  const label = escapeHtml(tag);
  return `<div class="ax-node ax-unknown" style="${style.join(';')}"><small>${label} · عنصر غير مدعوم بصرياً</small>${childElements(element).map((child) => renderNode(child, resources, files, depth + 1, budget)).join('')}</div>`;
}

export function buildAndroidLayoutPreview(path: string, content: string, files: Record<string, { content: string }>): AndroidLayoutPreview | null {
  if (!/\.xml$/i.test(path)) return null;
  const document = parseXml(content);
  if (!document) return null;
  const root = document.documentElement;
  if (!root) return null;
  const rootName = localName(root);
  if (!ROOT_LAYOUTS.has(rootName) && !rootName.endsWith('Layout')) return null;
  const resources = loadResources(files);
  const budget = { count: 0 };
  const body = renderNode(root, resources, files, 0, budget);
  return {
    title: `${path} · معاينة Android تقريبية`,
    diagnostics: ['هذه معاينة بصرية تقريبية لعناصر Android الشائعة؛ لا تنفّذ شيفرة Android ولا تحاكي قيود التخطيط أو السمات بالكامل. أزرار وعناصر التحكم للعرض فقط.'],
    html: `<main class="ax-preview"><div class="ax-label"><span class="ax-badge">ANDROID XML</span><span>معاينة تقريبية · العناصر غير تفاعلية</span></div><div class="ax-device"><div class="ax-status"><span>9:41</span><span>◔ ▮ ▰</span></div><div class="ax-screen">${body}</div><div class="ax-nav"><i></i></div></div></main>`,
  };
}

export const androidLayoutPreviewCss = `
.ax-preview{min-height:100vh;box-sizing:border-box;padding:14px 12px 22px;background:radial-gradient(ellipse at top,#283228 0,#111511 58%);color:#f2f4ef;font:13px system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;gap:13px}
.ax-label{width:min(100%,420px);display:flex;justify-content:space-between;align-items:center;gap:8px;color:#c5cec0;font-size:11px}.ax-badge{color:#a9ec76;font-size:10px;font-weight:800;letter-spacing:.14em;border:1px solid #a9ec7650;border-radius:20px;padding:5px 9px}
.ax-device{width:min(100%,390px);min-height:650px;flex:1;display:flex;flex-direction:column;background:#f4f5f2;color:#191d18;border:7px solid #30362e;border-radius:28px;overflow:hidden;box-shadow:0 22px 65px #0009}.ax-status{height:27px;flex:none;display:flex;justify-content:space-between;align-items:center;padding:0 16px;background:#f4f5f2;font-size:11px;font-weight:650}.ax-screen{flex:1;min-height:0;overflow:auto;padding:8px;box-sizing:border-box;background:#f4f5f2}.ax-nav{height:24px;flex:none;display:grid;place-items:center;background:#f4f5f2}.ax-nav i{width:108px;height:4px;border-radius:4px;background:#252922}
.ax-node{box-sizing:border-box}.ax-container{display:flex;flex-direction:column;gap:8px;align-items:stretch;min-width:0}.ax-row{flex-direction:row;align-items:center}.ax-stack{display:flex;flex-direction:column;gap:8px}.ax-frame{position:relative}.ax-scroll{overflow:auto;max-height:100%;overscroll-behavior:contain}.ax-empty{border:1px dashed #9aa294;border-radius:10px;padding:18px;color:#70796c;text-align:center;font-size:12px}.ax-text{line-height:1.45;overflow-wrap:anywhere}.ax-button-wrap{display:flex;align-items:center}.ax-button{min-height:42px;max-width:100%;border:0;border-radius:8px;background:#557b34;color:white;padding:0 18px;font:600 14px system-ui,sans-serif;box-shadow:0 2px 3px #0002}.ax-image{min-height:42px;display:grid;place-items:center;border:1px dashed #a7aea2;border-radius:8px;color:#737c70;background:#edf0e9}.ax-image img{max-width:100%;max-height:260px;object-fit:contain}.ax-input-wrap input{width:100%;box-sizing:border-box;min-height:46px;border:1px solid #8a9384;border-radius:6px;background:transparent;padding:0 12px;font:14px system-ui,sans-serif;color:#20241e}.ax-choice{display:flex;align-items:center;gap:10px;min-height:32px}.ax-choice-dot{width:17px;height:17px;border:2px solid #73806c;border-radius:50%;box-sizing:border-box;flex:none}.ax-progress{height:4px;background:#cbd1c5;border-radius:4px;overflow:hidden}.ax-progress span{display:block;width:42%;height:100%;background:#527c30}.ax-space{min-height:12px}.ax-unknown{border-inline-start:2px solid #d39b4a;padding:6px 8px}.ax-unknown small{display:block;color:#85672e;font-size:10px;margin-bottom:4px}
@media(max-width:520px){.ax-preview{padding:10px 8px 14px}.ax-device{min-height:min(650px,calc(100dvh - 104px));border-radius:22px}}
`;
