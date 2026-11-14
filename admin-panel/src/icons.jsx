// Creative icon treatment: lucide line icons rendered duotone (the closed shapes are filled with a
// light tint, the outline drawn in a deeper shade) inside a soft gradient squircle. Tones are
// decorative identity only; status meaning always comes with a text label.

export const TONES = ['green', 'orange', 'violet', 'blue', 'rose', 'amber', 'teal', 'ink'];

export function DuoIcon({ icon: Icon, tone = 'green', size = 40, iconSize, tilt = false, className = '' }) {
  const s = iconSize ?? Math.round(size * 0.5);
  return (
    <span
      className={`duo duo-${tone} ${tilt ? 'duo-tilt' : ''} ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.32) }}
      aria-hidden="true"
    >
      <Icon size={s} strokeWidth={1.8} fill="var(--duo-fill)" stroke="var(--duo-stroke)" />
    </span>
  );
}

// The Nurvia mark: a paw built from five soft shapes, with an orange heart-shaped main pad.
export function NurviaMark({ size = 34, color = '#ff7a45' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="12" fill={color} />
      <g fill="#fff8f0">
        <ellipse cx="11.5" cy="16" rx="3.2" ry="4.2" transform="rotate(-18 11.5 16)" />
        <ellipse cx="17" cy="10.5" rx="3.2" ry="4.4" transform="rotate(-6 17 10.5)" />
        <ellipse cx="23.5" cy="10.5" rx="3.2" ry="4.4" transform="rotate(6 23.5 10.5)" />
        <ellipse cx="29" cy="16" rx="3.2" ry="4.2" transform="rotate(18 29 16)" />
        <path d="M20 34c-1.2 0-9.5-5-9.5-10.2 0-3 2.3-5 5-5 2 0 3.5 1.1 4.5 2.6 1-1.5 2.5-2.6 4.5-2.6 2.7 0 5 2 5 5C29.5 29 21.2 34 20 34z" />
      </g>
    </svg>
  );
}
