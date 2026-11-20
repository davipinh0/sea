// Logo do SEA: uma prateleira de quatro níveis (0 a 3), como os endereços do SP12. As cores vêm das
// variáveis de App.css.
export default function SeaLogo({ size = 28 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="SEA"
      style={{ flexShrink: 0 }}
    >
      <rect x="1" y="1" width="30" height="30" rx="5" fill="var(--brand-orange)" />
      <g stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round">
        <line x1="7" y1="5.5" x2="7" y2="26.5" />
        <line x1="25" y1="5.5" x2="25" y2="26.5" />
        <line x1="7" y1="10.5" x2="25" y2="10.5" />
        <line x1="7" y1="16" x2="25" y2="16" />
        <line x1="7" y1="21.5" x2="25" y2="21.5" />
        <line x1="7" y1="26.5" x2="25" y2="26.5" />
      </g>
      <g fill="#FFFFFF">
        <rect x="9.5" y="17.6" width="5" height="3" rx="0.6" />
        <rect x="16" y="12.1" width="6.5" height="3" rx="0.6" />
        <rect x="9.5" y="23.1" width="4" height="2.6" rx="0.6" opacity="0.75" />
      </g>
    </svg>
  );
}
