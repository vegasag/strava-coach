import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = process.env.PROFILE_PATH || path.resolve(__dirname, '../user_profile.json');

export type ProfileEntry = {
  content: string;
  added: string; // ISO timestamp
};

export type UserProfile = {
  treningspreferanser: ProfileEntry[];
  skader: ProfileEntry[];
  mål: ProfileEntry[];
  øktlogging: ProfileEntry[];
  personlig: ProfileEntry[];
  annet: ProfileEntry[];
  treningsfilosofi: string | null;
};

export type ProfileSection = keyof Omit<UserProfile, 'treningsfilosofi'>;

const ENTRY_SECTIONS: ProfileSection[] = [
  'treningspreferanser',
  'skader',
  'mål',
  'øktlogging',
  'personlig',
  'annet',
];

const ALL_SECTIONS = [...ENTRY_SECTIONS, 'treningsfilosofi'] as const;

function emptyProfile(): UserProfile {
  return {
    treningspreferanser: [],
    skader: [],
    mål: [],
    øktlogging: [],
    personlig: [],
    annet: [],
    treningsfilosofi: null,
  };
}

export function loadProfile(): UserProfile {
  try {
    const raw = fs.readFileSync(PROFILE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const profile = emptyProfile();
    for (const section of ENTRY_SECTIONS) {
      if (Array.isArray(data[section])) {
        profile[section] = data[section];
      }
    }
    if (typeof data.treningsfilosofi === 'string') {
      profile.treningsfilosofi = data.treningsfilosofi;
    }
    return profile;
  } catch {
    return emptyProfile();
  }
}

function saveProfile(profile: UserProfile) {
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
}

export function addToProfile(section: string, content: string): string {
  if (section === 'treningsfilosofi') {
    return setTrainingPhilosophy(content);
  }
  if (!isValidEntrySection(section)) {
    return `Ugyldig seksjon: ${section}. Gyldige: ${[...ENTRY_SECTIONS, 'treningsfilosofi'].join(', ')}`;
  }
  const profile = loadProfile();
  profile[section].push({
    content,
    added: new Date().toISOString(),
  });
  saveProfile(profile);
  return `Lagret i "${section}".`;
}

export function setTrainingPhilosophy(text: string): string {
  const profile = loadProfile();
  profile.treningsfilosofi = text;
  saveProfile(profile);
  return 'Treningsfilosofi oppdatert.';
}

export function removeFromProfile(section: ProfileSection, index: number): string {
  const profile = loadProfile();
  if (!profile[section] || index < 0 || index >= profile[section].length) {
    return 'Ugyldig indeks.';
  }
  profile[section].splice(index, 1);
  saveProfile(profile);
  return `Fjernet oppføring ${index} fra "${section}".`;
}

export function formatProfileForLLM(): string {
  const profile = loadProfile();
  const parts: string[] = [];

  // Treningsfilosofi first — it's the core reference
  if (profile.treningsfilosofi) {
    parts.push('### Treningsfilosofi');
    parts.push(profile.treningsfilosofi);
    parts.push('');
  }

  for (const section of ENTRY_SECTIONS) {
    const entries = profile[section];
    if (entries.length === 0) continue;
    parts.push(`### ${section.charAt(0).toUpperCase() + section.slice(1)}`);
    for (const entry of entries) {
      const date = entry.added.slice(0, 10);
      parts.push(`- [${date}] ${entry.content}`);
    }
    parts.push('');
  }

  if (parts.length === 0) return '';
  return '--- BRUKERPROFIL (lagret informasjon) ---\n' + parts.join('\n');
}

function isValidEntrySection(s: string): s is ProfileSection {
  return ENTRY_SECTIONS.includes(s as ProfileSection);
}

export function isValidSection(s: string): boolean {
  return ALL_SECTIONS.includes(s as any);
}
