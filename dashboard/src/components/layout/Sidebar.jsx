import {
  IconAbout,
  IconAnalytics,
  IconControl,
  IconHome,
  IconLeaf,
} from "./NavIcons.jsx";

const PRIMARY_NAV = [
  { id: "home", label: "Home", Icon: IconHome },
  { id: "control", label: "Control", Icon: IconControl },
  { id: "analytics", label: "Analytics", Icon: IconAnalytics },
];

const FOOTER_NAV = [{ id: "about", label: "About", Icon: IconAbout }];

function NavButton({ item, active, onNavigate }) {
  const { Icon } = item;
  return (
    <button
      type="button"
      className={active ? "side-link is-active" : "side-link"}
      aria-current={active ? "page" : undefined}
      onClick={() => onNavigate(item.id)}
    >
      <Icon className="side-link-icon" />
      <span>{item.label}</span>
    </button>
  );
}

export function Sidebar({ page, onNavigate }) {
  return (
    <aside className="sidebar" aria-label="Primary">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" aria-hidden="true">
          <IconLeaf className="sidebar-brand-icon" />
        </span>
        <div>
          <p className="sidebar-brand-title">Greenhouse</p>
          <p className="sidebar-brand-sub">Analytics</p>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        {PRIMARY_NAV.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={page === item.id}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <nav className="sidebar-footer-nav" aria-label="Secondary">
        {FOOTER_NAV.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={page === item.id}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </aside>
  );
}
