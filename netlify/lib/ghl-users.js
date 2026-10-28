"use strict";
// Every active user on the A2Z GHL location (for Admin -> add a person). Needs GHL_PIT_TOKEN with users.readonly.
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_USERS_API_VERSION = "2023-02-21";
const DEFAULT_GHL_LOCATION_ID = "QUcu2PEAxPV1sQm1GQCq";

// Returns every active user on the A2Z location (throws on GHL errors).
async function fetchLocationUsers() {
  const token = String(process.env.GHL_PIT_TOKEN || "").trim();
  const locationId = String(process.env.GHL_LOCATION_ID || DEFAULT_GHL_LOCATION_ID).trim();
  if (!token) { const e = new Error("Missing GHL_PIT_TOKEN environment variable"); e.status = 500; throw e; }
  const url = `${GHL_BASE}/users/?locationId=${encodeURIComponent(locationId)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_USERS_API_VERSION,
      Accept: "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(data.message || data.error || `GHL user sync failed (${response.status})`);
    e.status = response.status;
    throw e;
  }
  const source = Array.isArray(data.users) ? data.users : (Array.isArray(data.data) ? data.data : []);
  return source
    .filter((user) => user && user.id && !user.deleted)
    .map((user) => ({
      id: String(user.id),
      name: user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
      email: String(user.email || "").toLowerCase(),
      // `phone` is the user's profile/mobile number. Do not use lcPhone or
      // twilioPhone here; those are GHL inbound/forwarding numbers.
      phone: user.phone || "",
    }));
}

module.exports = { fetchLocationUsers };
