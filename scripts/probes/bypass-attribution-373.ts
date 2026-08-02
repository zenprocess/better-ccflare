// Reproduce validator logic from PR #378.
// isLowRiskProjectSlug = Option 1 surface (6-word sentence cap).
// isLowRiskPathSegment = Option 2 surface (zero-whitespace, used in current PR).
// We add a synthetic Option 3 surface (2-word cap) inline below for comparison.

const CTRL_RE = /[\x00-\x1F\x7F]/;
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SECRET_TOKEN_RE = /\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9]{8,}/i;
const KNOWN_SECRET_PREFIX_RE = /\bgh[opsur]_[A-Za-z0-9]{6,}\b|\bxox[baprs]-[A-Za-z0-9-]{6,}\b/i;
const MULTI_SEGMENT_TOKEN_RE =
  /\b(?:[A-Za-z0-9]+[_-]){2,}(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}\b/;
const AWS_KEY_RE = /AKIA[0-9A-Z]{12,}/;
const LONG_TOKEN_RE = /[A-Za-z0-9]{20,}/;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const HEX_OPAQUE_TOKEN_RE = /\b[0-9a-fA-F]{16,}\b/;
const OPAQUE_MIXED_TOKEN_RE =
  /\b(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}\b/;
const DOTTED_HOSTNAME_LABEL_RE = /[A-Za-z0-9]\.[A-Za-z0-9]/;
const SLUG_SHAPE_RE = /^[\w.][\w .-]{0,63}$/;

function isLowRiskPathSegment(value: string): boolean {
  if (CTRL_RE.test(value)) return false;
  const cleaned = value.trim();
  if (!cleaned) return false;
  const lower = cleaned.toLowerCase();
  if (
    lower.includes("://") ||
    lower.includes("www.") ||
    URI_SCHEME_RE.test(cleaned)
  )
    return false;
  if (
    cleaned.startsWith("/") ||
    cleaned.startsWith("\\") ||
    cleaned.includes("..")
  )
    return false;
  const atIndex = cleaned.indexOf("@");
  if (atIndex !== -1 && cleaned.indexOf(".", atIndex) !== -1) return false;
  if (UUID_RE.test(cleaned)) return false;
  if (
    SECRET_TOKEN_RE.test(cleaned) ||
    KNOWN_SECRET_PREFIX_RE.test(cleaned) ||
    MULTI_SEGMENT_TOKEN_RE.test(cleaned) ||
    lower.includes("bearer ") ||
    AWS_KEY_RE.test(cleaned) ||
    IPV4_RE.test(cleaned) ||
    LONG_TOKEN_RE.test(cleaned) ||
    HEX_OPAQUE_TOKEN_RE.test(cleaned) ||
    OPAQUE_MIXED_TOKEN_RE.test(cleaned)
  )
    return false;
  if (/\s/.test(cleaned)) return false; // OPTION 2 strict rejection
  return SLUG_SHAPE_RE.test(cleaned);
}

function isLowRiskProjectSlug(value: string): boolean {
  if (CTRL_RE.test(value)) return false;
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (!cleaned) return false;
  const lower = cleaned.toLowerCase();
  if (
    lower.includes("://") ||
    lower.includes("www.") ||
    URI_SCHEME_RE.test(cleaned)
  )
    return false;
  if (
    cleaned.startsWith("/") ||
    cleaned.startsWith("\\") ||
    cleaned.includes("..")
  )
    return false;
  const atIndex = cleaned.indexOf("@");
  if (atIndex !== -1 && cleaned.indexOf(".", atIndex) !== -1) return false;
  if (UUID_RE.test(cleaned)) return false;
  if (DOTTED_HOSTNAME_LABEL_RE.test(cleaned)) return false;
  if (
    SECRET_TOKEN_RE.test(cleaned) ||
    KNOWN_SECRET_PREFIX_RE.test(cleaned) ||
    MULTI_SEGMENT_TOKEN_RE.test(cleaned) ||
    lower.includes("bearer ") ||
    AWS_KEY_RE.test(cleaned) ||
    IPV4_RE.test(cleaned) ||
    LONG_TOKEN_RE.test(cleaned) ||
    HEX_OPAQUE_TOKEN_RE.test(cleaned) ||
    OPAQUE_MIXED_TOKEN_RE.test(cleaned)
  )
    return false;
  // OPTION 1: 6-word cap
  if (cleaned.split(/\s+/).filter(Boolean).length > 6) return false;
  return SLUG_SHAPE_RE.test(cleaned);
}

function option3TwoWordCap(value: string): boolean {
  const r = isLowRiskProjectSlug(value);
  if (!r) return false;
  // Option 3 adds: if whitespace, cap at 2 words.
  if (/\s/.test(value)) {
    const words = value.replace(/[\x00-\x1F\x7F]/g, "").trim().split(/\s+/).filter(Boolean);
    if (words.length > 2) return false;
  }
  return true;
}

// === Probe set ===
const cases: Array<[string, string]> = [
  // Baselines
  ["baseline legit dir", "better-ccflare"],
  ["baseline 'ui.v2'", "ui.v2"],

  // ===== Option 1 (6-word cap) leaks =====
  [
    "1.1 customer fragment 4 words (Acme subsidiary internal)",
    "Acme Corp subsidiary internal",
  ],
  [
    "1.2 internal codename + marker (Project Phoenix Confidential)",
    "Project Phoenix Confidential",
  ],
  [
    "1.3 operational tail 5 words (PHOENIX SkyNet operational review notes)",
    "PHOENIX SkyNet operational review notes",
  ],
  [
    "1.4 incident-shaped 5 words (Internal legal hold pending)",
    "Internal legal hold pending",
  ],
  [
    "1.5 4-words hostname-shaped (prod aws amazon com)",
    "prod aws amazon com",
  ],
  [
    "1.6 5-words with HN-shaped internals but spaces, not dotted",
    "Production host rotated cluster",
  ],

  // ===== Option 3 (2-word cap) attempts =====
  [
    "3.1 customer name 'Acme Corp'",
    "Acme Corp",
  ],
  [
    "3.2 codename 'Project Phoenix'",
    "Project Phoenix",
  ],
  [
    "3.3 single-word codename 'Nimbus'",
    "Nimbus",
  ],
  [
    "3.4 single-word tool 'Strapi'",
    "Strapi",
  ],
  [
    "3.5 single-word spec 'Draft2024Q4'",
    "Draft2024Q4",
  ],
  [
    "3.6 2-word pair 'Internal Only'",
    "Internal Only",
  ],
  [
    "3.7 2-word pair 'Do Not'",
    "Do Not",
  ],
  [
    "3.8 2-word pair 'eyes only'",
    "eyes only",
  ],
  [
    "3.9 directory with 2 words but no actual secret (Customer Portal)",
    "Customer Portal",
  ],
  [
    "3.10 single-word but 'Phoenix' w/o Project",
    "Phoenix",
  ],

  // ===== Option 2 (zero-whitespace) bypass attempts =====
  ["2.1 U+00A0 nbsp", "Acme Corp"],
  ["2.2 U+2009 thin space", "Acme Corp"],
  ["2.3 U+3000 ideographic space", "Acme　Corp"],
  ["2.4 U+202F narrow no-break space", "Acme Corp"],
  ["2.5 U+200B zero-width space", "Acme​Corp"],
  ["2.6 U+FEFF BOM (zero-width no-break space)", "Acme﻿Corp"],
  ["2.7 U+2060 word joiner", "Acme⁠Corp"],
  ["2.8 \\t between", "Acme\tCorp"],
  ["2.9 \\f between", "Acme\fCorp"],
  ["2.10 \\v between", "Acme\vCorp"],
  ["2.11 raw LF in capture", "Acme\nCorp"],
  ["2.12 raw NUL \\x00 in capture", "Acme\x00Corp"],
  ["2.13 U+FF0F (fullwidth slash) in capture", "abc／def"],
  ["2.14 percent-encoded simple", "%20only"],
  ["2.15 dotted hostname 'intranet.corp.example'", "intranet.corp.example"],
  ["2.16 single dotted 'foo.bar'", "foo.bar"],
  ["2.17 incident label 'INC-12345'", "INC-12345"],
  ["2.18 jira 'PROJ-12345'", "PROJ-12345"],
  ["2.19 cred-label 'api-key' w/o tail", "api-key"],
  ["2.20 single-word codename 'Nimbus'", "Nimbus"],
  ["2.21 'StargateC2Channel'", "StargateC2Channel"],
  [
    "2.22 secret-shaped compound 'ProjectPhoenixV2Secret'",
    "ProjectPhoenixV2Secret",
  ],
  [
    "2.23 normal-looking but contain 'Secret' 'MySecretRepo'",
    "MySecretRepo",
  ],
  [
    "2.24 IP-shaped as single segment '10-0-0-5' (no dots, all hyphens)",
    "10-0-0-5",
  ],
  ["2.25 16-hex run 'deadbeefcafebabe'", "deadbeefcafebabe"],
  [
    "2.26 host:port-like 'intranet:8080' (colon)",
    "intranet:8080",
  ],
  ["2.27 63-char safe but real 'MyCo-2026-Q4-Confidential-Q3-roadmap'", "MyCo-2026-Q4-Confidential-Q3-roadmap"],
];

let passO1 = 0, passO2 = 0, passO3 = 0;
console.log(
  `O1=6word  O2=nowsp  O3=2word | label : value`,
);
console.log("---");
for (const [label, val] of cases) {
  const o1 = isLowRiskProjectSlug(val);
  const o2 = isLowRiskPathSegment(val);
  const o3 = option3TwoWordCap(val);
  if (o1) passO1++;
  if (o2) passO2++;
  if (o3) passO3++;
  console.log(
    `${o1 ? "O1✓ " : "O1✗ "} ${o2 ? "O2✓ " : "O2✗ "} ${o3 ? "O3✓ " : "O3✗ "} | ${label}: ${JSON.stringify(val)}`,
  );
}
console.log("---");
console.log(
  `Total accepted: O1=${passO1}/${cases.length}, O2=${passO2}/${cases.length}, O3=${passO3}/${cases.length}`,
);
