import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Upload, X } from 'lucide-react';
import { iconComponents } from './icon-components';
import type { AndroidIdentity } from '../types';

const iconNames = `Activity Airplay AlarmClock Anchor Aperture Archive ArchiveRestore ArrowDown ArrowDownLeft ArrowLeft ArrowRight ArrowUp AtSign Award Axe BadgeCheck Banknote BarChart3 Battery Bell Bike Bluetooth Book Bookmark Box Briefcase Brush Bug Building2 Bus Cake Calculator Calendar Camera Car Check CheckCircle2 ChefHat Chrome CircleUserRound Clipboard Clock Cloud Code2 Coffee Cog Compass Contact Copy Cpu CreditCard Database Diamond Dices Download Dribbble Droplet Edit3 ExternalLink Eye EyeOff Facebook File FileArchive FileCode2 FileImage FileJson FileText Film Filter Fingerprint Flag Flame Flashlight FlaskConical Flower2 Folder FolderOpen Gamepad2 Gauge Gem Gift Github Globe Globe2 GraduationCap Grid2X2 Hammer HardDrive Headphones Heart HelpCircle Home Image Instagram Key Lamp Laptop Layers Leaf Lightbulb Link2 List Lock Mail Map MapPin Medal Menu MessageCircle Mic Monitor Moon Mountain Music Network Newspaper Package Paintbrush Palette Paperclip PawPrint Pencil Phone PieChart Pin Plane Play Plug Power Printer Puzzle QrCode Radio Rocket Rss Save Scale Scan Search Settings Shield ShoppingBag ShoppingCart Smartphone Smile Snowflake Sparkles Speaker Star Sun Sunrise Sword Tag Target Terminal ThumbsUp Ticket Timer ToggleRight Trash2 TreePine Trophy Truck Tv Umbrella Unlock Upload User Users Video Wallet WandSparkles Watch Wifi Wind Wrench Zap`.split(' ');
const components = iconComponents;
const fallbackIcon = components.Code2;

interface IconLibraryProps {
  value: AndroidIdentity;
  onChange: (value: AndroidIdentity) => void;
  onClose: () => void;
}

export function IconLibrary({ value, onChange, onClose }: IconLibraryProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return iconNames.filter((name) => !term || name.toLowerCase().includes(term));
  }, [query]);
  const Selected = components[value.iconName] ?? fallbackIcon;

  function update(patch: Partial<AndroidIdentity>) {
    onChange({ ...value, ...patch });
  }

  async function uploadIcon(file?: File) {
    if (!file) return;
    if (!/^image\/(?:png|jpeg|webp)$/.test(file.type)) {
      window.alert('اختر صورة PNG أو JPEG أو WebP.');
      return;
    }
    if (file.size > 512 * 1024) {
      window.alert('يجب ألا يتجاوز حجم الأيقونة 512 كيلوبايت.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') update({ uploadedIcon: reader.result });
    };
    reader.readAsDataURL(file);
  }

  return createPortal(<div className="modal-backdrop icon-library-backdrop" role="presentation" style={{ zIndex: 10010 }} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="dialog icon-dialog" role="dialog" aria-modal="true" aria-labelledby="icon-dialog-title">
      <header className="dialog-head"><div><span className="eyebrow">هوية التطبيق</span><h2 id="icon-dialog-title">اسم وأيقونة Android</h2></div><button className="icon-button" onClick={onClose} aria-label="إغلاق"><X size={18} /></button></header>
      <div className="identity-form">
        <label className="field-label">اسم التطبيق الظاهر على الهاتف<input className="text-input" value={value.appName} maxLength={32} onChange={(event) => update({ appName: event.target.value })} placeholder="مثال: مفكرتي" /></label>
        <div className="icon-preview-row">
          <div className={`app-icon-shape ${value.iconShape}`} style={{ background: value.iconBackground }}>
            {value.uploadedIcon ? <img src={value.uploadedIcon} alt="الأيقونة المرفوعة" /> : <Selected size={34} color={value.iconForeground} strokeWidth={1.8} />}
          </div>
          <div><b>معاينة الأيقونة</b><span>تظهر داخل تطبيق Android بعد البناء</span></div>
          <label className="secondary-button upload-control"><Upload size={16} /> رفع صورة<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadIcon(event.target.files?.[0])} hidden /></label>
          {value.uploadedIcon && <button className="icon-button" onClick={() => update({ uploadedIcon: undefined })} aria-label="إزالة الصورة"><X size={16} /></button>}
        </div>
        <div className="color-row">
          <label className="field-label compact">خلفية الأيقونة<input type="color" value={value.iconBackground} onChange={(event) => update({ iconBackground: event.target.value })} /></label>
          <label className="field-label compact">لون الرمز<input type="color" value={value.iconForeground} onChange={(event) => update({ iconForeground: event.target.value })} /></label>
          <label className="field-label compact">شكل الأيقونة<select className="select-input" value={value.iconShape} onChange={(event) => update({ iconShape: event.target.value as AndroidIdentity['iconShape'] })}><option value="rounded">مربع ناعم</option><option value="circle">دائري</option><option value="squircle">مربع مستدير</option></select></label>
        </div>
        {!value.uploadedIcon && <>
          <div className="icon-library-heading"><div><b>مكتبة الأيقونات</b><span>{iconNames.length} رمزاً محلياً</span></div><label className="search-field icon-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث عن أيقونة" /></label></div>
          <div className="icon-grid" aria-label="مكتبة الأيقونات">
            {filtered.map((name) => {
              const Icon = components[name] ?? fallbackIcon;
              return <button className={`icon-choice ${value.iconName === name ? 'selected' : ''}`} key={name} title={name} aria-label={`اختيار أيقونة ${name}`} onClick={() => update({ iconName: name })}><Icon size={20} /></button>;
            })}
          </div>
        </>}
      </div>
      <footer className="dialog-foot"><span className="subtle-note">ستُرسل الملفات إلى خدمة البناء بعد موافقتك فقط.</span><button className="primary-button" onClick={onClose}>حفظ الهوية</button></footer>
    </section>
  </div>, document.body);
}
