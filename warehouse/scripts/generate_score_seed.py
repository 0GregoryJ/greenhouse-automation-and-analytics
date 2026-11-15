import csv
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]

config = json.loads(
    (root / "config/environmental_score.v1.json").read_text()
)

destination = (
    root / "warehouse/seeds/environmental_score_rules.csv"
)

destination.parent.mkdir(parents=True, exist_ok=True)

with destination.open("w", newline="") as file:
    writer = csv.writer(file)

    writer.writerow([
        "score_version",
        "measurement_type",
        "unit",
        "weight",
        "target_min",
        "target_max",
        "tolerance_below",
        "tolerance_above",
        "valid_min",
        "valid_max",
    ])

    for name, rule in config["metrics"].items():
        writer.writerow([
            config["version"],
            name,
            rule["unit"],
            rule["weight"],
            rule["target_min"],
            rule["target_max"],
            rule["tolerance_below"],
            rule["tolerance_above"],
            rule["valid_min"],
            rule["valid_max"],
        ])

print(f"Generated {destination}")
