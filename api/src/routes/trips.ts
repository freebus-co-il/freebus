import type { FastifyPluginAsync } from "fastify";
import { parseLang } from "../db/i18n.js";
import { getTrip } from "../db/lines.js";
import { config } from "../config.js";

export const tripRoutes: FastifyPluginAsync = async (app) => {
  app.get("/trips/:tripId", {
    schema: {
      params: { type: "object", required: ["tripId"], properties: { tripId: { type: "string" } } },
      querystring: { type: "object", properties: { lang: { type: "string" } } },
    },
  }, async (req) => {
    const { tripId } = req.params as { tripId: string };
    const { lang } = req.query as { lang?: string };
    let parsed;
    try { parsed = parseLang(lang); }
    catch (err) { throw app.httpErrors.badRequest((err as Error).message); }
    // `app.calendar` read fresh per request (it is a getter over the current
    // bundle), so the service date these ISO times render against follows a
    // feed swap rather than being pinned to whatever was live at boot.
    const trip = getTrip(app.db.db, app.translator, tripId, parsed, {
      calendar: app.calendar, tz: config.timezone,
    });
    if (trip === null) throw app.httpErrors.notFound(`No trip with id ${tripId}`);
    return trip;
  });
};
