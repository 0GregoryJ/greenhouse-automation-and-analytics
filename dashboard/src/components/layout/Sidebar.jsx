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

function NavButton({ item, active, onNavigate, collapsed }) {
  const { Icon } = item;
  return (
    <button
      type="button"
      className={active ? "side-link is-active" : "side-link"}
      aria-current={active ? "page" : undefined}
      aria-label={item.label}
      title={collapsed ? item.label : undefined}
      onClick={() => onNavigate(item.id)}
    >
      <Icon className="side-link-icon" />
      {!collapsed && <span>{item.label}</span>}
    </button>
  );
}

export function Sidebar({ page, onNavigate, collapsed, onToggleCollapsed }) {
  return (
    <aside
      className={collapsed ? "sidebar is-collapsed" : "sidebar"}
      aria-label="Primary"
    >
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark" aria-hidden="true">
            <IconLeaf className="sidebar-brand-icon" />
          </span>
          {!collapsed && (
            <div>
              <p className="sidebar-brand-title">Greenhouse</p>
              <p className="sidebar-brand-sub">Analytics</p>
            </div>
          )}
        </div>

        <button
          type="button"
          className="sidebar-collapse"
          onClick={onToggleCollapsed}
          aria-pressed={collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Main">
        {PRIMARY_NAV.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={page === item.id}
            onNavigate={onNavigate}
            collapsed={collapsed}
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
            collapsed={collapsed}
          />
        ))}
      </nav>
    </aside>
  );
}
