import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSiriResponse, buildSnapshotUrl, redactKey } from "./siri.js";

const ICD_EXAMPLE = {
  Siri: { ServiceDelivery: {
    ResponseTimestamp: "2019-05-11T12:40:46.148+03:00",
    StopMonitoringDelivery: [{
      ResponseTimestamp: "2019-05-11T12:40:46.148+03:00",
      MonitoredStopVisit: [{
        RecordedAtTime: "2019-05-11T12:40:42+03:00",
        MonitoringRef: "51202",
        MonitoredVehicleJourney: {
          LineRef: "1209", DirectionRef: "2",
          FramedVehicleJourneyRef: {
            DataFrameRef: "2019-05-11", DatedVehicleJourneyRef: "20925867" },
          PublishedLineName: "1", OperatorRef: "6",
          OriginRef: "51102", DestinationRef: "51202",
          OriginAimedDepartureTime: "2019-05-11T12:15:00+03:00",
          ConfidenceLevel: "probablyReliable",
          VehicleLocation: { Longitude: "34.991028", Latitude: "32.663611" },
          Bearing: "43.40886", VehicleRef: "9030930",
          MonitoredCall: { StopPointRef: "52202", Order: "5",
                           ExpectedArrivalTime: "2019-05-11T13:12:02+03:00" },
          OnwardCalls: { OnwardCall: [
            { StopPointRef: "52203", Order: "6",
              ExpectedArrivalTime: "2019-05-11T13:15:00+03:00" }] },
        },
      }],
    }],
  } },
};

test("parses the ICD's worked example", () => {
  const snap = parseSiriResponse(ICD_EXAMPLE, 1_557_570_046);
  assert.equal(snap.journeys.length, 1);
  // length === 1 just above guarantees index 0 exists.
  const j = snap.journeys[0]!;
  assert.equal(j.lineRef, "1209");
  // SIRI DirectionRef 1,2,3 maps to GTFS direction_id 0,1,2.
  assert.equal(j.directionId, 1);
  assert.equal(j.vehicleRef, "9030930");
  assert.equal(j.lat, 32.663611);
  // The monitored call comes first, then the onward calls.
  assert.deepEqual(j.calls.map((c) => c.stopCode), ["52202", "52203"]);
  // The deepEqual above guarantees calls has exactly 2 entries, so index 0 exists.
  assert.equal(j.calls[0]!.order, 5);
  // One visit in, one visit surviving, none dropped.
  assert.equal(snap.visitsSeen, 1);
  assert.equal(snap.visitsDropped, 0);
});

test("an ErrorCondition is an error, not an empty snapshot", () => {
  // An auth failure arrives inside an HTTP 200. A parser that only checks the
  // status code would report "no vehicles anywhere" forever.
  const payload = { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{
    ErrorCondition: { OtherError: { ErrorText: "API key is not authorized" } },
  }] } } };
  assert.throws(() => parseSiriResponse(payload, 0), /not authorized/);
});

// SIRI carries a SERVICE-wide error too, one level
// above the per-delivery spot the ICD documents and the test just above
// exercises. A parser that only checked the per-delivery spot would file
// this under "not a SIRI envelope" with the error text thrown away.
test("a ServiceDelivery-level ErrorCondition is an error too, not merely 'not a SIRI envelope'", () => {
  const payload = { Siri: { ServiceDelivery: {
    ErrorCondition: { OtherError: { ErrorText: "rate limit exceeded" } },
  } } };
  assert.throws(() => parseSiriResponse(payload, 0), /rate limit exceeded/);
});

test("a journey missing its LineRef is dropped, not fatal", () => {
  const payload = { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{
    MonitoredStopVisit: [
      { MonitoredVehicleJourney: { DirectionRef: "1" } },
      ICD_EXAMPLE.Siri.ServiceDelivery.StopMonitoringDelivery[0]!.MonitoredStopVisit[0],
    ],
  }] } } };
  const snap = parseSiriResponse(payload, 0);
  assert.equal(snap.journeys.length, 1, "the good journey survives the bad one");
  // 2 visits seen, 1 dropped -- not merely "1 journey",
  // which alone can't tell a quiet feed from a feed dropping half its visits.
  assert.equal(snap.visitsSeen, 2);
  assert.equal(snap.visitsDropped, 1);
});

test("visitsDropped counts every kind of unusable visit: missing LineRef, missing DirectionRef, and no usable calls", () => {
  const good = ICD_EXAMPLE.Siri.ServiceDelivery.StopMonitoringDelivery[0]!.MonitoredStopVisit[0];
  const payload = { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{
    MonitoredStopVisit: [
      good,
      { MonitoredVehicleJourney: { DirectionRef: "1" } }, // missing LineRef
      { MonitoredVehicleJourney: { LineRef: "1209" } }, // missing DirectionRef
      { MonitoredVehicleJourney: { LineRef: "1209", DirectionRef: "1" } }, // no usable calls
    ],
  }] } } };
  const snap = parseSiriResponse(payload, 0);
  assert.equal(snap.journeys.length, 1);
  assert.equal(snap.visitsSeen, 4);
  assert.equal(snap.visitsDropped, 3);
});

test("shapes the document does not describe do not crash the parser", () => {
  // On first contact the real service will differ from the ICD somewhere.
  for (const payload of [{}, { Siri: {} }, { Siri: { ServiceDelivery: {} } },
                         { Siri: { ServiceDelivery: { StopMonitoringDelivery: {} } } },
                         { Siri: { ServiceDelivery: { StopMonitoringDelivery: [] } } }]) {
    const snap = parseSiriResponse(payload, 0);
    assert.equal(snap.journeys.length, 0);
  }
});

test("a single delivery object is accepted as well as an array", () => {
  // SIRI-to-JSON converters differ on whether a one-element list is an array.
  const one = ICD_EXAMPLE.Siri.ServiceDelivery.StopMonitoringDelivery[0];
  const snap = parseSiriResponse(
    { Siri: { ServiceDelivery: { StopMonitoringDelivery: one } } }, 0);
  assert.equal(snap.journeys.length, 1);
});

test("the snapshot URL matches the ICD's format and never leaks the key", () => {
  const url = buildSnapshotUrl("https://mot.example/siri", "DM1234", "active-calls");
  assert.match(url, /\/2\.8\/json\?/);
  assert.match(url, /MonitoringRef=AllActiveTripsFilter/);
  assert.match(url, /StopVisitDetailLevel=calls/);
  // ICD 7.18.3: snapshot requests must not carry these.
  for (const forbidden of ["PreviewInterval", "StartTime", "LineRef",
                           "MaximumStopVisits", "MaximumNumberOfCallsOnwards"]) {
    assert.doesNotMatch(url, new RegExp(forbidden));
  }
});

test("buildSnapshotUrl strips a trailing slash from the base URL", () => {
  // The base address is pasted into an env var by a human; assume it will
  // sometimes carry a trailing slash.
  const url = buildSnapshotUrl("https://mot.example/siri/", "DM1234", "planned");
  assert.match(url, /^https:\/\/mot\.example\/siri\/2\.8\/json\?/);
  assert.doesNotMatch(url, /siri\/\/2\.8/);
});

test("redactKey replaces the Key value and leaves the rest of the URL intact", () => {
  const url = "https://mot.example/siri/2.8/json?Key=DM1234"
    + "&MonitoringRef=AllActiveTripsFilter&StopVisitDetailLevel=calls";
  assert.equal(
    redactKey(url),
    "https://mot.example/siri/2.8/json?Key=***"
      + "&MonitoringRef=AllActiveTripsFilter&StopVisitDetailLevel=calls",
  );
});

test("redactKey matches the Key parameter name case-insensitively", () => {
  assert.equal(redactKey("https://mot.example/x?key=DM1234"), "https://mot.example/x?key=***");
  assert.equal(redactKey("https://mot.example/x?KEY=DM1234"), "https://mot.example/x?KEY=***");
});

test("redactKey does not touch a parameter whose name merely contains 'key'", () => {
  // Redaction must not be claimable by accident by a differently-named param.
  const url = "https://mot.example/x?OtherKey=DM1234&MonitoringKey=abc";
  assert.equal(redactKey(url), url);
});

test("redactKey works whether Key is first in the query or comes after another param", () => {
  assert.equal(redactKey("https://mot.example/x?Key=DM1234&Foo=bar"),
    "https://mot.example/x?Key=***&Foo=bar");
  assert.equal(redactKey("https://mot.example/x?Foo=bar&Key=DM1234"),
    "https://mot.example/x?Foo=bar&Key=***");
});

test("redactKey returns a URL with no key unchanged", () => {
  const url = "https://mot.example/x?Foo=bar";
  assert.equal(redactKey(url), url);
});

test("the redacted output never contains the original secret, anywhere", () => {
  // The property that actually matters: assert it directly so it survives a
  // future rewrite of the redaction regex.
  const secret = "sup3r-Secret_Key99";
  const url = `https://mot.example/x?Foo=bar&Key=${secret}&Baz=qux`;
  assert.ok(!redactKey(url).includes(secret));
});
