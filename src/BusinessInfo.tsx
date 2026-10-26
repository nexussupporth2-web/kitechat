import { Clock, Globe, Mail, MapPin, Phone } from 'lucide-react';

export interface Business {
  phone: string;
  showPhone: boolean;
  businessName: string;
  bizCategory: string;
  description: string;
  address: string;
  mapLink: string;
  hours: { open: string; close: string; closed: boolean }[] | null;
  email: string;
  website: string;
  about: string;
  socials: Record<string, string>;
  coverUrl: string | null;
  products: { id: string; name: string; price: string; description: string; photoUrl: string | null }[];
}

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const BIZ_CATEGORIES = ['Retail / Shop', 'Restaurant / Cafe', 'Grocery', 'Fashion & Clothing', 'Electronics', 'Beauty & Salon', 'Health & Pharmacy', 'Services', 'Education', 'Real Estate', 'Automobile', 'Other'];
export const SOCIALS: [string, string][] = [
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['youtube', 'YouTube'],
  ['x', 'X (Twitter)'],
  ['linkedin', 'LinkedIn'],
  ['whatsapp', 'WhatsApp']
];

export const defaultHours = () => DAYS.map((_, i) => ({ open: '09:00', close: '18:00', closed: i === 6 }));

const time12 = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const Row = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) => (
  <div className="flex gap-3 text-sm text-slate-200">
    <span className="text-slate-400 mt-0.5 shrink-0">{icon}</span>
    <div className="min-w-0 break-words">{children}</div>
  </div>
);

const link = 'text-cyan-400 underline underline-offset-2';

/** Read-only business profile: cover, details, hours, links and the product catalogue. */
export default function BusinessInfo({ b, hideCover }: { b: Business; hideCover?: boolean }) {
  const has = b.businessName || b.description || b.address || b.mapLink || b.email || b.website || b.phone || b.about || b.coverUrl || b.products.length || Object.keys(b.socials).length;
  if (!has) return null;
  const today = (new Date().getDay() + 6) % 7;
  return (
    <div className="mt-6">
      {b.coverUrl && !hideCover && <img src={b.coverUrl} alt="" className="w-full h-36 object-cover" />}
      <div className="px-4 mt-4 space-y-4">
        {(b.businessName || b.bizCategory) && (
          <div>
            {b.businessName && <h3 className="text-lg font-semibold text-white">{b.businessName}</h3>}
            {b.bizCategory && <span className="inline-block mt-1 px-3 py-1 rounded-full bg-slate-800 text-xs text-slate-300">{b.bizCategory}</span>}
          </div>
        )}
        {b.about && <p className="text-sm italic text-slate-300">“{b.about}”</p>}
        {b.description && <p className="text-sm text-slate-300 whitespace-pre-line">{b.description}</p>}

        <div className="space-y-2.5">
          {b.address && <Row icon={<MapPin className="w-4 h-4" />}>{b.address}</Row>}
          {b.mapLink && (
            <Row icon={<MapPin className="w-4 h-4" />}>
              <a href={b.mapLink} target="_blank" rel="noopener noreferrer" className={link}>Open in Google Maps</a>
            </Row>
          )}
          {b.phone && (
            <Row icon={<Phone className="w-4 h-4" />}>
              <a href={`tel:${b.phone}`} className={link}>{b.phone}</a>
            </Row>
          )}
          {b.email && (
            <Row icon={<Mail className="w-4 h-4" />}>
              <a href={`mailto:${b.email}`} className={link}>{b.email}</a>
            </Row>
          )}
          {b.website && (
            <Row icon={<Globe className="w-4 h-4" />}>
              <a href={b.website} target="_blank" rel="noopener noreferrer" className={link}>{b.website.replace(/^https?:\/\//, '')}</a>
            </Row>
          )}
        </div>

        {b.hours && (
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
              <Clock className="w-4 h-4" /> Business hours
            </div>
            <div className="rounded-2xl bg-slate-800/60 divide-y divide-slate-700/50">
              {b.hours.map((h, i) => (
                <div key={i} className={`flex justify-between px-4 py-2 text-sm ${i === today ? 'text-white font-semibold' : 'text-slate-300'}`}>
                  <span>{DAYS[i]}</span>
                  <span>{h.closed ? 'Closed' : `${time12(h.open)} – ${time12(h.close)}`}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {Object.keys(b.socials).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {SOCIALS.filter(([k]) => b.socials[k]).map(([k, label]) => (
              <a key={k} href={b.socials[k]} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-full bg-slate-800 text-xs text-slate-200 hover:bg-slate-700">
                {label}
              </a>
            ))}
          </div>
        )}

        {b.products.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Products</div>
            <div className="grid grid-cols-2 gap-3">
              {b.products.map(p => (
                <div key={p.id} className="rounded-2xl bg-slate-800/60 overflow-hidden">
                  {p.photoUrl ? <img src={p.photoUrl} alt="" loading="lazy" className="w-full aspect-square object-cover" /> : <div className="w-full aspect-square bg-slate-800" />}
                  <div className="p-3">
                    <div className="text-sm font-semibold text-white break-words">{p.name}</div>
                    {p.price && <div className="text-sm text-cyan-400">{p.price}</div>}
                    {p.description && <div className="mt-1 text-xs text-slate-400 break-words">{p.description}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
