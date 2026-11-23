import { ComingSoonPanel } from "../components/shared/ComingSoonPanel.jsx";

export function ControlPage() {
  return (
    <section className="view" aria-label="Control">
      <div className="view-toolbar">
        <div>
          <h2 className="view-title">Control</h2>
          <p className="view-copy">
            Manual overrides and actuator controls will live here.
          </p>
        </div>
      </div>

      <ComingSoonPanel
        title="Actuator control"
        description="Fan and pump controls, safety limits, and override history are not wired into the dashboard yet. Local automation on the gateway continues to run independently."
      />
    </section>
  );
}
