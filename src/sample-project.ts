import type { CodeProject } from './types';

export function createSampleProject(): CodeProject {
  const now = Date.now();
  const id = crypto.randomUUID();
  return {
    id,
    name: 'مشروعي الأول',
    entry: 'index.html',
    createdAt: now,
    updatedAt: now,
    android: {
      appName: 'تطبيقي',
      packageId: `com.codexa.p${id.replaceAll('-', '').slice(0, 10)}`,
      iconName: 'Sparkles',
      iconBackground: '#A9EC76',
      iconForeground: '#10130F',
      iconShape: 'rounded',
      allowExternalNetwork: false,
    },
    files: {
      'index.html': {
        path: 'index.html',
        languageOverride: null,
        updatedAt: now,
        content: '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>فكرتك تبدأ هنا</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main class="card">\n    <div class="mark">{ }</div>\n    <p class="eyebrow">مساحة عملك الجديدة</p>\n    <h1>فكرتك تبدأ<br><span>من سطر واحد.</span></h1>\n    <p class="body">اكتب شيفرتك، وشاهدها تتشكل مباشرةً في المعاينة.</p>\n    <button id="action">جرّب التفاعل <span>←</span></button>\n    <small id="status">كل شيء جاهز للبداية</small>\n  </main>\n  <script src="script.js"></script>\n</body>\n</html>\n',
      },
      'style.css': {
        path: 'style.css',
        languageOverride: null,
        updatedAt: now,
        content: "@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap');\n:root { font-family: 'IBM Plex Sans Arabic', sans-serif; color-scheme: dark; }\n* { box-sizing: border-box; }\nbody { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 28px; color: #f4f5f0; background: radial-gradient(circle at 18% 15%, #273225 0, #151a14 32%, #0d100d 72%); }\n.card { width: min(100%, 440px); padding: 38px; border: 1px solid #ffffff18; border-radius: 28px; background: linear-gradient(145deg, #1d241cdd, #111511ee); box-shadow: 0 28px 90px #0008; }\n.mark { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 17px; color: #10130f; background: #a9ec76; font: 700 17px 'IBM Plex Mono', monospace; }\n.eyebrow { margin: 32px 0 12px; color: #a9ec76; font-size: 13px; }\nh1 { margin: 0; font-size: clamp(32px, 9vw, 46px); line-height: 1.35; letter-spacing: -.04em; }\nh1 span { color: #a9ec76; }\n.body { max-width: 30ch; margin: 18px 0 26px; color: #b2bbb0; line-height: 1.9; }\nbutton { border: 0; border-radius: 14px; padding: 13px 18px; background: #a9ec76; color: #10130f; font: 600 14px inherit; cursor: pointer; }\nbutton span { margin-inline-start: 12px; }\nsmall { display: block; margin-top: 22px; color: #798477; }\n",
      },
      'script.js': {
        path: 'script.js',
        languageOverride: null,
        updatedAt: now,
        content: "const button = document.querySelector('#action');\nconst status = document.querySelector('#status');\nbutton?.addEventListener('click', () => {\n  status.textContent = 'شيفرتك تعمل — تابع البناء.';\n  button.textContent = 'تم التفاعل ✓';\n});\n",
      },
    },
  };
}
