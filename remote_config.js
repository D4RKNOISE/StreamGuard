const STREAMGUARD_API_URL = "https://script.google.com/macros/s/AKfycbyw1WKqQgsJb9RQ1Hyd03J3tRlaazszbT0WWeXczRhNZthapOhg5prK5hQrdcSmzRzL/exec";
const STREAMGUARD_CACHE_KEY = "streamguard_remote_cache_v1";
const STREAMGUARD_CACHE_TTL = 5 * 60 * 1000;
const STREAMGUARD_GITHUB_URL = "https://github.com/D4RKNOISE/StreamGuard";
const STREAMGUARD_AVAILABLE_MODULES = Object.freeze({
  cinegram: {
    adguard: true,
    fillbrowserscreen: true
  }
});

async function streamguardFetchRemote(force = false) {
  const cached = await chrome.storage.local.get([STREAMGUARD_CACHE_KEY]);
  const cache = cached[STREAMGUARD_CACHE_KEY];

  if (!force && cache && (Date.now() - cache.fetchedAt < STREAMGUARD_CACHE_TTL)) {
    return Array.isArray(cache.rows) ? cache.rows : [];
  }

  const res = await fetch(STREAMGUARD_API_URL, { cache: "no-store" });
  if (!res.ok) {
    if (cache?.rows) return cache.rows;
    throw new Error("Remote fetch failed: " + res.status);
  }

  const json = await res.json();
  const rows = Array.isArray(json) ? json : (Array.isArray(json?.rows) ? json.rows : []);

  await chrome.storage.local.set({
    [STREAMGUARD_CACHE_KEY]: {
      fetchedAt: Date.now(),
      rows
    }
  });

  return rows;
}

async function streamguardClearRemoteCache() {
  await chrome.storage.local.remove([STREAMGUARD_CACHE_KEY]);
}

function streamguardNormalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

function streamguardFindByDomain(rows, hostname) {
  const host = streamguardNormalizeDomain(hostname);
  if (!host) return null;

  return rows.find((row) => {
    const d = streamguardNormalizeDomain(row.domain);
    return d && (host === d || host.endsWith("." + d) || d.endsWith("." + host));
  }) || null;
}

function streamguardGuessGroupNameFromDomain(domain) {
  const normalized = streamguardNormalizeDomain(domain);
  if (!normalized) return "Suggested Site";

  const base = normalized.split(".")[0] || normalized;
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Suggested Site";
}

function streamguardBuildCombinedRows(remoteRows, userDomains) {
  const remote = Array.isArray(remoteRows) ? remoteRows : [];
  const local = Array.isArray(userDomains) ? userDomains : [];

  return remote.map((row) => {
    const groupName = String(row.group_name || streamguardGuessGroupNameFromDomain(row.domain)).trim();
    const slug = streamguardSlugFromGroup(groupName);
    const status = String(row.status || "").trim().toLowerCase();
    const moduleInfo = streamguardGetModuleInfo(slug);

    return {
      ...row,
      group_name: groupName,
      domain: streamguardNormalizeDomain(row.domain),
      status,
      source: row.source || "remote",
      group_slug: slug,
      module_available: moduleInfo.available,
      module_features: moduleInfo.features,
      update_required: status === "supported" && !moduleInfo.available
    };
  }).concat(
    local.map((item) => ({
      group_name: String(item.group_name || streamguardGuessGroupNameFromDomain(item.domain)).trim(),
      domain: streamguardNormalizeDomain(item.domain),
      status: String(item.status || "local").trim().toLowerCase(),
      submitted_at: item.submitted_at || "",
      submitted_note: item.submitted_note || "",
      review_note: item.review_note || "",
      rejection_reason: item.rejection_reason || "",
      favorite_score: item.favorite_score || 0,
      delivery_status: item.delivery_status || "local_only",
      submitted_remote_at: item.submitted_remote_at || "",
      source: "local",
      group_slug: streamguardSlugFromGroup(item.group_name || streamguardGuessGroupNameFromDomain(item.domain)),
      module_available: false,
      module_features: [],
      update_required: false
    }))
  ).filter((row) => row.domain);
}

function streamguardGroupRows(rows) {
  const grouped = new Map();

  rows.forEach((row) => {
    const groupName = String(row.group_name || "Other").trim() || "Other";
    const domain = streamguardNormalizeDomain(row.domain);
    const status = String(row.status || "").trim().toLowerCase();

    if (!domain) return;

    if (!grouped.has(groupName)) {
      grouped.set(groupName, {
        groupName,
        domains: [],
        rows: [],
        favoriteScore: 0,
        moduleAvailable: false,
        updateRequiredCount: 0,
        counts: {
          supported: 0,
          reviewing: 0,
          rejected: 0,
          suggested: 0,
          local: 0,
          other: 0
        }
      });
    }

    const group = grouped.get(groupName);
    const normalizedRow = {
      ...row,
      domain,
      status,
      source: row.source || "remote"
    };

    group.rows.push(normalizedRow);
    group.domains.push(domain);
    group.favoriteScore += Number(row.favorite_score || 0);
    group.moduleAvailable = group.moduleAvailable || Boolean(row.module_available);
    if (row.update_required) group.updateRequiredCount += 1;

    if (Object.prototype.hasOwnProperty.call(group.counts, status)) {
      group.counts[status] += 1;
    } else {
      group.counts.other += 1;
    }
  });

  return Array.from(grouped.values()).map((group) => ({
    ...group,
    domains: [...new Set(group.domains)].sort(),
    rows: group.rows.sort((a, b) => {
      const statusOrder = ["supported", "reviewing", "suggested", "local", "rejected"];
      const ai = statusOrder.indexOf(a.status);
      const bi = statusOrder.indexOf(b.status);
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.domain.localeCompare(b.domain);
    })
  }));
}

function streamguardSlugFromGroup(groupName) {
  return String(groupName || "")
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function streamguardGetModuleInfo(groupOrSlug) {
  const slug = streamguardSlugFromGroup(groupOrSlug);
  const entry = STREAMGUARD_AVAILABLE_MODULES[slug];
  if (!entry) {
    return { slug, available: false, features: [] };
  }

  const features = Object.keys(entry).filter((key) => Boolean(entry[key]));
  return {
    slug,
    available: features.length > 0,
    features
  };
}
