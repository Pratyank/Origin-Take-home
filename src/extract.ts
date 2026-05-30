import type { Discipline, ExtractedIntake, InboxItem } from "./types.js";

export interface TriageSignals {
  /** A disclosure suggesting harm, abuse, neglect, or unsafe caregiving. */
  safeguarding: boolean;
  /** Family is communicating in / requesting Spanish. */
  spanish: boolean;
  /** A reschedule or cancellation request for an existing appointment. */
  reschedule: boolean;
  /** The request concerns something happening today (same-day operational). */
  sameDay: boolean;
  /** A developmental / clinical-advice question rather than a referral. */
  clinicalQuestion: boolean;
  /** Looks like spam or an FYI with no action. */
  spam: boolean;
}

export interface Extraction {
  intake: ExtractedIntake;
  signals: TriageSignals;
  /** Human-readable field names that are missing and needed for intake. */
  missing: string[];
}

const BLANK = /^\s*(\[?\s*blank\s*\]?|n\/a|none|unknown|-+)\s*$/i;

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/[.;,]+$/, "").trim();
  if (!trimmed || BLANK.test(trimmed)) return null;
  return trimmed;
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const value = clean(m[1]);
      if (value) return value;
    }
  }
  return null;
}

const NAME = "[A-Z][A-Za-z'’-]+";

function extractChildName(text: string, subject: string): string | null {
  return firstMatch(`${text}\n${subject}`, [
    new RegExp(`Child:\\s*(${NAME}(?:\\s+${NAME}){0,3})`),
    new RegExp(`(?:referral for|eval(?:uation)? for)\\s+(${NAME}(?:\\s+${NAME}){0,2})`),
    new RegExp(`(?:my (?:son|daughter|child|hij[ao])|mi hij[ao])\\s+(${NAME}(?:\\s+${NAME}){0,2})`),
    /year[\s-]old\s+([A-Z][a-z]+)/,
    new RegExp(`(${NAME}(?:\\s+${NAME})?)\\s+threw up`),
  ]);
}

function extractDobOrAge(text: string): string | null {
  const dob = firstMatch(text, [
    /DOB:?\s*(\d{4}-\d{2}-\d{2})/i,
    /DOB\s+(?:is\s+)?(\d{4}-\d{2}-\d{2})/i,
    /\bDOB:?\s*([A-Za-z0-9 ,/-]+\d{4})/i,
  ]);
  if (dob) return dob;

  const age = firstMatch(text, [
    /(\d{1,2})[\s-]*year[\s-]*old/i,
    /(?:he|she|is|tiene)\s+(?:is\s+)?(\d{1,2})\b(?!\d)/i,
    /tiene\s+(\d{1,2})\s+a[nñ]os/i,
  ]);
  if (age) return `age ${age}`;
  if (/school-age/i.test(text)) return "school-age (unspecified)";
  return null;
}

function extractContact(text: string, sender: string): string | null {
  const phone = firstMatch(text, [/\b(\d{3}-\d{3}-\d{4})\b/, /\b(\d{3}-\d{4})\b/]);
  const email = firstMatch(`${text}\n${sender}`, [/([\w.+-]+@[\w-]+\.[\w.-]+)/]);
  const name = firstMatch(`${text}\n${sender}`, [
    new RegExp(`Parent(?:/guardian)?:\\s*(${NAME}(?:\\s+${NAME}){0,2})`),
    new RegExp(`I am (?:his|her|their) parent,?\\s*(${NAME}(?:\\s+${NAME}){0,2})`),
    new RegExp(`(?:this is|soy)\\s+(${NAME}(?:\\s+${NAME}){0,2})`),
    new RegExp(`^(${NAME}(?:\\s+${NAME}){0,2})\\s*<`, "m"),
    new RegExp(`^(${NAME}(?:\\s+${NAME}){0,2})\\s+via`, "m"),
  ]);
  const parts = [name, phone, email].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

const DISCIPLINE_HINTS: Array<[Discipline, RegExp]> = [
  ["SLP", /\b(slp|speech|speech-language|articulation|intelligibilit|language delay|stutter|r sounds|habla|lenguaje)\b/i],
  ["OT", /\b(ot|occupational|sensory|feeding|fine motor|handwriting|self-regulation|self regulation)\b/i],
  ["PT", /\b(pt|physical therapy|gait|toe walking|tripping|balance|gross motor|walking)\b/i],
];

function extractDiscipline(text: string): Discipline[] | null {
  const explicit = text.match(/Discipline requested:\s*(SLP|OT|PT)/i);
  const found = new Set<Discipline>();
  if (explicit) found.add(explicit[1].toUpperCase() as Discipline);
  for (const [discipline, pattern] of DISCIPLINE_HINTS) {
    if (pattern.test(text)) found.add(discipline);
  }
  return found.size ? [...found] : null;
}

function extractConcern(text: string): string | null {
  return firstMatch(text, [
    /(?:Concern|Diagnosis\/concern|Diagnosis or concern):\s*([^.\n]+)/i,
    /(?:evaluation|eval) for\s+([^.\n]+)/i,
    /Necesita una?\s+([^.\n]+)/i,
  ]);
}

function extractPayer(text: string): string | null {
  const labeled = firstMatch(text, [
    /Insurance(?: is)?:?\s*([^.,\n]+)/i,
    /Tenemos\s+([A-Za-z ]+?)(?:,|\.)/i,
  ]);
  if (labeled) return labeled;
  if (/\bmedicaid\b/i.test(text)) return "Medicaid";
  return null;
}

function extractMemberId(text: string): string | null {
  return firstMatch(text, [
    /member\s*id:?\s*([A-Z0-9][A-Z0-9-]+)/i,
    /miembro\s+([A-Z0-9][A-Z0-9-]+)/i,
  ]);
}

// Safeguarding net. Deliberately broad on explicit harm language (recall over
// precision — a missed disclosure is far worse than a human-reviewed false
// alarm) while anchoring ambiguous words (scared/afraid, physical verbs) to a
// caregiver/home context so routine messages (e.g. "scared of the dentist",
// "feeding therapy") don't escalate. Subtler phrasings are caught by the LLM
// layer's safeguarding flag, which is OR'd with this in src/llm.ts.
const SAFEGUARDING_PATTERNS = [
  // explicit physical harm toward the child (anchored to a child object)
  "getting rough",
  "rough with (?:him|her|them|the)",
  // physical-harm verbs: object is him/them (unambiguous) or "her" only when it
  // is the object of the clause, not a possessive ("punches her pillow")
  "(?:hit|hits|hitting|beat|beats|beating|slap|slaps|slapped|punch|punches|punching|kick|kicks|kicking|choke|chokes|choked|whips?)\\s+(?:him|them|the (?:kid|child|baby)|my (?:son|daughter|child|kid)|her(?!\\s+(?:pillow|toy|toys|doll|dolls|teddy|bear|blanket|brother|sister|sibling|cousin|friends?|hair|room|bed|stuff|things|snacks?|lunch|food|backpack|books?|crayons?|tablet|ipad|phone|own|grandma|grandpa|mom|mum|dad|teacher)))",
  "hurt(?:s|ing)?\\s+(?:him|her|them)",
  // abuse / neglect terms (strong enough to stand alone)
  "abus(?:e|ive|ed)",
  "neglect(?:ed|ful)?",
  "mistreat(?:ed|ment)?",
  "maltreat(?:ed|ment)?",
  "molest(?:s|ed|ing)?",
  // violence: anchored to a person/home, not movies/games/sports
  "domestic (?:violence|abuse)",
  "(?:gets?|getting|got|turns?|becomes?|is|been|was) violent",
  "violent (?:when|with|toward|towards|at home|outbursts?)",
  // injury signs
  "bruis(?:e|es|ed|ing)",
  "welts?",
  "marks on (?:his|her|their|the)\\s+(?:arm|arms|body|back|legs?|face|neck)",
  // neglect / unsafe supervision / deprivation
  "left (?:him|her|them) alone",
  "home alone",
  "alone all day",
  "unsupervised",
  "(?:not|isn'?t|aren'?t) (?:being )?fed",
  "going hungry",
  "no food (?:at home|in the house)",
  "starv(?:e|ed|ing|ation)?",
  "(?:hasn'?t|has not|haven'?t|have not)\\s+(?:eaten|been fed|fed (?:him|her|them))",
  "lock(?:s|ed|ing)? (?:him|her|them)? ?(?:in|up)",
  // fear of a caregiver — anchored to a caregiver person or going home, NOT bare "home"
  "(?:scared|afraid|frightened|terrified)\\b.{0,30}?\\b(?:dad|daddy|father|mom|mommy|mother|step-?dad|step-?mom|parents?|guardian|go home|going home)",
  "flinch(?:es|ing)?\\b.{0,30}?\\b(?:dad|daddy|father|mom|mommy|mother|comes home|at home)",
  // inappropriate contact
  "touched (?:him|her|them|me)(?: inappropriately)?",
  "inappropriate(?:ly)? touch",
  // safety framed around the child/home — scoped so "unsafe waiting room" does NOT match
  "unsafe\\s+(?:at home|at his|at her|around (?:him|her|them|dad|mom)|with (?:him|her|them|dad|mom))",
  "(?:home|house) (?:is|isn'?t|feels|felt)\\s*(?:not )?safe",
  "(?:not|isn'?t|aren'?t) safe\\s+(?:at home|with|around|there)",
  "(?:can'?t|cannot|couldn'?t|unable to|can no longer)\\s+keep (?:him|her|them|the (?:child|kid|baby)) safe",
  "keep (?:him|her|them) safe (?:at home|from (?:his|her|their)|anymore)",
  "threaten(?:s|ed|ing)?\\s+(?:to (?:hurt|hit|kill|harm|beat)|him|her|them|the (?:kid|child)|violence)",
  // Spanish harm / neglect / fear (the inbox includes Spanish-speaking families)
  "le pegan?",
  "le golpean?",
  "l[oa] golpea",
  "me pega",
  "maltrat[ao]",
  "maltrata",
  "abus[ao]\\b(?! de (?:los|las)\\b)",
  "abusan de (?:[ée]l|ella|ellos|su)",
  "violencia (?:dom[eé]stica|en casa|familiar)",
  "le hace da[ñn]o",
  "l[oa] lastima",
  "deja\\w*\\s+sol[oa]",
  "sol[oa]s?\\s+(?:en casa|todo el d[ií]a)",
  "miedo\\s+(?:de|a)\\s+su\\s+(?:pap|mam|padre|madre)",
  "pasa hambre",
  "no le dan de comer",
];
const SAFEGUARDING = new RegExp(`\\b(?:${SAFEGUARDING_PATTERNS.join("|")})`, "i");

function detectSignals(rawText: string, channel: string): TriageSignals {
  // Normalize curly/smart apostrophes (U+2019 etc.) to ASCII so patterns using
  // "isn't"/"hasn't"/"can't" match transcripts from phones and voicemail tools.
  const text = rawText.replace(/[‘’ʼ′]/g, "'");
  const lower = text.toLowerCase();
  const reschedule = /\b(reschedule|cancel|can'?t make|cannot make|can not make|move (?:my|the) appointment)\b/i.test(text);
  const sameDay = /\b(today|today'?s|this morning|this afternoon|hoy|right now)\b/i.test(text);
  return {
    safeguarding: SAFEGUARDING.test(text),
    spanish: /\b(hola|soy|necesita|gracias|espa[nñ]ol|mi hij[ao]|tel[eé]fono|a[nñ]os)\b/i.test(text),
    reschedule,
    sameDay,
    clinicalQuestion:
      /\b(is it normal|is this normal|normal that|should i be worried|should we wait|do you think|is it concerning)\b/i.test(
        text,
      ) && !/Discipline requested|referral/i.test(text),
    spam:
      /\b(unsubscribe|limited time offer|click here|congratulations you|viagra|crypto)\b/i.test(lower) &&
      channel === "email",
  };
}

export function extractItem(item: InboxItem): Extraction {
  const text = `${item.subject}\n${item.body}`;
  const intake: ExtractedIntake = {
    child_name: extractChildName(item.body, item.subject),
    dob_or_age: extractDobOrAge(text),
    parent_contact: extractContact(item.body, item.sender),
    discipline: extractDiscipline(text),
    diagnosis_or_concern: extractConcern(text),
    payer: extractPayer(text),
    member_id: extractMemberId(text),
  };

  const missing: string[] = [];
  if (!intake.child_name) missing.push("child name");
  if (!intake.dob_or_age) missing.push("date of birth or age");
  if (!intake.parent_contact) missing.push("parent/guardian contact");
  if (!intake.discipline) missing.push("requested discipline");
  if (!intake.payer) missing.push("insurance payer");
  if (!intake.member_id) missing.push("insurance member ID");

  return { intake, signals: detectSignals(text, item.channel), missing };
}
