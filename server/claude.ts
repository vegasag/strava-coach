import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addToProfile, type ProfileSection } from './profile.js';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Last inn all referanselitteratur (.md) fra philosophy-mappa ved oppstart.
// Slipp nye .md-filer inn der – de plukkes opp automatisk uten kodeendring.
function loadPhilosophy(): string {
  const dir = path.resolve(__dirname, 'philosophy');
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    const parts = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'));
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

const PHILOSOPHY = loadPhilosophy();

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const SYSTEM_PROMPT = `Du er en treningssparringspartner som følger Marius Bakken-modellen (norsk utholdenhetstrening).

Kjernefilosofi du skal følge:
- Terskeltrening er ryggraden – ofte styrt av laktat eller kontrollert puls
- Mye volum i lav intensitet (sone 1–2), lite i "grå sone"
- Strukturerte 7- eller 14-dagers mikrosykluser
- Doble terskeløkter på enkelte dager hos viderekomne
- Progresjon respekteres – volum før intensitet

Brukerens kontekst:
- 2 m høy, slank, tidligere godt trent (har løpt maraton)
- Comeback-fase etter 3 år med to barn, selskap, flytting
- Mål: halvmaraton/maraton
- Nivå nå: 30–60 km/uke
- Kjent svakhet: venstre kne (lateralt) som blusser opp ved for rask progresjon

Stil:
- Svar på bokmål
- Vær konkret og direkte, ikke svulstig
- Si fra hvis noe er usikkert eller utenfor din kompetanse (medisinsk vurdering, etc.)
- Hvis treningsdata er vedlagt under, bruk den til å gi spesifikke råd, ikke generiske

Du har tilgang til et verktøy for å lagre informasjon til brukerens profil. Bruk dette når brukeren ber deg huske noe, eller når du lærer viktig informasjon som bør huskes til fremtidige samtaler.

Gyldige seksjoner:
- treningspreferanser: Foretrukne treningsformer, tempo, utstyr, tid på døgnet, etc.
- skader: Nåværende og tidligere skader, begrensninger
- mål: Kortsiktige og langsiktige treningsmål, konkurranser
- øktlogging: Hvordan brukeren logger økter, klokke, apper, vaner
- personlig: Personlig info relevant for trening (jobb, familie, søvn, etc.)
- annet: Alt annet som er verdt å huske
- treningsfilosofi: Brukerens treningsfilosofi (lengre tekst, overskriver forrige). Bruk denne kun når brukeren eksplisitt ber om å lagre treningsfilosofi.
`;

const SAVE_TOOL: Anthropic.Tool = {
  name: 'save_to_profile',
  description:
    'Lagre informasjon til brukerens profil for fremtidige samtaler. Bruk dette når brukeren ber deg huske noe, eller når du oppdager viktig info som bør være persistent.',
  input_schema: {
    type: 'object' as const,
    properties: {
      section: {
        type: 'string',
        enum: [
          'treningspreferanser',
          'skader',
          'mål',
          'øktlogging',
          'personlig',
          'annet',
          'treningsfilosofi',
        ],
        description: 'Hvilken seksjon informasjonen hører til',
      },
      content: {
        type: 'string',
        description: 'Informasjonen som skal lagres (kort og konkret)',
      },
    },
    required: ['section', 'content'],
  },
};

type SaveToolInput = {
  section: ProfileSection;
  content: string;
};

export async function chat(opts: {
  messages: ChatMessage[];
  trainingContext?: string;
  profileContext?: string;
}): Promise<{ text: string; usage: any; saved?: { section: string; content: string }[] }> {
  // Fast del (system-prompt + Bakken-referanse) endrer seg aldri → caches.
  // Dynamisk del (profil + treningsdata) varierer per forespørsel → ucachet.
  let staticSystem = SYSTEM_PROMPT;
  if (PHILOSOPHY) {
    staticSystem += `\n\n--- REFERANSE: MARIUS BAKKEN-METODEN (fast kunnskapsgrunnlag) ---\n${PHILOSOPHY}`;
  }

  const dynamicParts: string[] = [];
  if (opts.profileContext) {
    dynamicParts.push(opts.profileContext);
  }
  if (opts.trainingContext) {
    dynamicParts.push(`--- BRUKERENS TRENINGSDATA ---\n${opts.trainingContext}`);
  }

  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: staticSystem,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (dynamicParts.length > 0) {
    system.push({ type: 'text', text: dynamicParts.join('\n\n') });
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system,
    messages: opts.messages,
    tools: [SAVE_TOOL],
  });

  const saved: { section: string; content: string }[] = [];
  let textParts: string[] = [];

  // Process initial response
  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }

  // Handle tool use — loop until no more tool calls
  let currentResponse = response;
  let currentMessages: Anthropic.MessageParam[] = [...opts.messages];

  while (currentResponse.stop_reason === 'tool_use') {
    const toolUseBlocks = currentResponse.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    // Add assistant message with all content blocks
    currentMessages.push({
      role: 'assistant',
      content: currentResponse.content,
    });

    // Process each tool call and build results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      if (toolUse.name === 'save_to_profile') {
        const input = toolUse.input as SaveToolInput;
        const result = addToProfile(input.section, input.content);
        saved.push({ section: input.section, content: input.content });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }
    }

    currentMessages.push({
      role: 'user',
      content: toolResults,
    });

    // Continue the conversation
    currentResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system,
      messages: currentMessages,
      tools: [SAVE_TOOL],
    });

    for (const block of currentResponse.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      }
    }
  }

  return {
    text: textParts.join('\n'),
    usage: response.usage,
    ...(saved.length > 0 ? { saved } : {}),
  };
}
