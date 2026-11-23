import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bandForReading,
  describeComponent,
  formatSuitability,
  limitedByLabel,
  limitingFactor,
} from "./scoreDisplay.js";

describe("bandForReading", () => {
  it("labels temperature below, in range, and above target", () => {
    assert.equal(bandForReading("air_temperature", 15).bandLabel, "too cold");
    assert.equal(bandForReading("air_temperature", 22).bandLabel, "in range");
    assert.equal(bandForReading("air_temperature", 30).bandLabel, "too warm");
  });

  it("labels humidity and soil bands", () => {
    assert.equal(bandForReading("relative_humidity", 70).bandKey, "below");
    assert.equal(bandForReading("relative_humidity", 70).bandLabel, "too dry");
    assert.equal(bandForReading("relative_humidity", 90).bandLabel, "in range");
    assert.equal(bandForReading("relative_humidity", 99).bandLabel, "too humid");
    assert.equal(bandForReading("soil_moisture", 20).bandLabel, "too dry");
    assert.equal(bandForReading("soil_moisture", 60).bandLabel, "in range");
    assert.equal(bandForReading("soil_moisture", 90).bandLabel, "too wet");
  });
});

describe("formatSuitability", () => {
  it("labels suitability out of 100", () => {
    assert.equal(formatSuitability(6), "6/100");
    assert.equal(formatSuitability(100), "100/100");
    assert.equal(formatSuitability(null), "—/100");
  });
});

describe("describeComponent", () => {
  it("pairs reading text with band and suitability", () => {
    const row = describeComponent({
      metric: "relative_humidity",
      reading: 70,
      score: 6,
    });

    assert.equal(row.label, "Humidity");
    assert.equal(row.readingLabel, "70.0 %");
    assert.equal(row.bandLabel, "too dry");
    assert.equal(row.suitabilityLabel, "6/100");
    assert.equal(row.suitability, 6);
  });
});

describe("limitedByLabel", () => {
  it("names the limiting factor", () => {
    assert.equal(
      limitedByLabel({ name: "relative_humidity", score: 6 }),
      "Mostly limited by humidity."
    );
  });
});

describe("limitingFactor", () => {
  it("explains a uniquely low component", () => {
    assert.equal(
      limitingFactor({
        air_temperature: 32,
        relative_humidity: 6,
        soil_moisture: 100,
      }),
      "Mostly limited by humidity."
    );
  });

  it("stays quiet when factors tie for lowest", () => {
    assert.equal(
      limitingFactor({
        air_temperature: 80,
        relative_humidity: 80,
        soil_moisture: 90,
      }),
      null
    );
  });
});
