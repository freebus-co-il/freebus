import yazl from "yazl";

export const FIXTURE_FILES: Record<string, string> = {
  "agency.txt":
    "agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone,agency_fare_url\n" +
    "2,רכבת ישראל,http://www.rail.co.il,Asia/Jerusalem,he,5770,\n",

  // Sunday-first, as in the real feed.
  "calendar.txt":
    "service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date\n" +
    "S1,1,1,1,1,1,0,0,20260821,20260920\n" +
    "S2,0,0,0,0,0,1,1,20260821,20260920\n",

  "routes.txt":
    "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color\n" +
    "R1,2,1,קו ראשון,67001-1-#,3,FF0000\n" +
    "R2,2,2,קו שני,67002-1-#,3,\n",

  "shapes.txt":
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
    "SH1,32.164723,34.848813,1\n" +
    "SH1,32.164738,34.848972,2\n" +
    "SH1,32.164771,34.849177,3\n",

  // Past-midnight departure on T2 exercises the >24h time rule.
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,shape_dist_traveled\n" +
    "T1,05:10:00,05:10:00,1,1,0,1,0\n" +
    "T1,05:12:23,05:12:23,2,2,0,0,714\n" +
    "T2,25:30:00,25:30:00,1,1,0,0,0\n",

  // Gershayim in an unquoted field, as in the real feed.
  "stops.txt":
    "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,location_type,parent_station,zone_id\n" +
    "1,38831,בי''ס בר לב/בן יהודה,רחוב: בן יהודה 74,32.183985,34.917554,0,,38831\n" +
    "2,38832,הרצל/צומת בילו,רחוב: הרצל,31.869152,34.819641,0,,38832\n",

  // Legacy three-column format; HE rows are identity mappings.
  "translations.txt":
    "trans_id,lang,translation\n" +
    "הרצל/צומת בילו,HE,הרצל/צומת בילו\n" +
    "הרצל/צומת בילו,EN,Herzl/Bilu Junction\n",

  // T2 has no shape, as many real trips do not.
  "trips.txt":
    "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,wheelchair_accessible\n" +
    "R1,S1,T1,910,0,SH1,1\n" +
    "R2,S2,T2,917,1,,\n",
};

/** Prepend a UTF-8 BOM and convert LF to CRLF, matching the real feed. */
function toFeedEncoding(body: string): Buffer {
  return Buffer.from("﻿" + body.replace(/\n/g, "\r\n"), "utf8");
}

export function buildFixtureZip(
  files: Record<string, string> = FIXTURE_FILES,
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const name of Object.keys(files).sort()) {
    zip.addBuffer(toFeedEncoding(files[name]!), name, { forceZip64Format: true });
  }
  // @types/yazl types `end`'s options as EndOptions (not Partial<EndOptions>),
  // so `comment` must be supplied even though yazl treats a missing comment
  // as "no comment" at runtime (see node_modules/yazl/index.js: `if (options.comment)`).
  zip.end({ forceZip64Format: true, comment: "" });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
