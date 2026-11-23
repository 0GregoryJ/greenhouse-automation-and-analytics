export function ComingSoonPanel({
  title,
  description,
  badge = "Coming soon",
}) {
  return (
    <section className="soon-panel" aria-label={`${title} (${badge})`}>
      <div className="soon-panel-head">
        <h2>{title}</h2>
        <span className="ai-badge">{badge}</span>
      </div>
      <p className="soon-panel-copy">{description}</p>
      <div className="soon-panel-placeholder" aria-hidden="true">
        <span className="soon-bar" />
        <span className="soon-bar soon-bar-mid" />
        <span className="soon-bar soon-bar-short" />
      </div>
    </section>
  );
}
