/**
 * Who a contact is and where they are from.
 *
 * Plain data with no imports so the New message form (src/) can import the
 * same lists the API validates against — one list, no drift between them.
 * Adding an option here is all it takes. Each list ends with "Other", which
 * lets the user type their own value; that text is stored as-is (no DB check).
 */

export const CONTACT_TYPES = [
  { value: 'employer', label: 'Employer' },
  { value: 'caregiver', label: 'Caregiver' },
  { value: 'recruiter', label: 'Recruiter' },
  { value: 'client_partner', label: 'Client / Partner' },
  { value: 'staff', label: 'Staff' },
  { value: 'other', label: 'Other' },
]

// ISO 3166-1 alpha-2 codes, plus OTHER for anyone not listed.
export const COUNTRIES = [
  { value: 'SG', label: 'Singapore' },
  { value: 'PH', label: 'Philippines' },
  { value: 'HK', label: 'Hong Kong' },
  { value: 'ID', label: 'Indonesia' },
  { value: 'MM', label: 'Myanmar' },
  { value: 'KH', label: 'Cambodia' },
  { value: 'MY', label: 'Malaysia' },
  { value: 'IN', label: 'India' },
  { value: 'LK', label: 'Sri Lanka' },
  { value: 'BD', label: 'Bangladesh' },
  { value: 'TH', label: 'Thailand' },
  { value: 'VN', label: 'Vietnam' },
  { value: 'OTHER', label: 'Other' },
]

// Display labels. An unknown value (contact_type was already filled from
// outside this app on some databases) is shown as-is rather than hidden.
export const contactTypeLabel = (v) =>
  v ? CONTACT_TYPES.find((t) => t.value === v)?.label ?? String(v) : null
export const countryLabel = (v) =>
  v ? COUNTRIES.find((c) => c.value === v)?.label ?? String(v) : null

// The "Other" option in each list. Picking it means "type your own"; what is
// stored is the typed text, not this placeholder.
export const isOtherOption = (v) => typeof v === 'string' && v.toLowerCase() === 'other'

const CUSTOM_MAX = 60

/**
 * Turn a submitted value into what gets stored: a known option's value, or the
 * typed free text (whitespace collapsed). Typed text that matches a listed
 * option ("singapore", "Employer") is folded onto that option so the filter
 * does not end up with duplicates. Returns null when nothing usable was sent,
 * including the bare "Other" placeholder.
 */
function normalize(list, value) {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/\s+/g, ' ')
  if (!text || isOtherOption(text) || text.length > CUSTOM_MAX) return null
  const lower = text.toLowerCase()
  const known = list.find(
    (o) => !isOtherOption(o.value) &&
      (o.value.toLowerCase() === lower || o.label.toLowerCase() === lower)
  )
  return known ? known.value : text
}

export const normalizeContactType = (v) => normalize(CONTACT_TYPES, v)
export const normalizeCountry = (v) => normalize(COUNTRIES, v)
