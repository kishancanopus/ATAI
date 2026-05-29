import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '@/lib/logger';

const DATA_DIR = join(process.cwd(), 'data');
const PRESETS_FILE = join(DATA_DIR, 'presets.json');

type PresetData = {
  searchingMode?: string;
  productCategory?: string;
  location: string;
  trendPeriod: string;
  variantLimitMax: string;
  resultsCap: string;
  kwpMinSearches: string;
  kwpMaxSearches: string;
  blacklistedWords: string[];
  googleTrendScore: number;
  amazonFilters: boolean;
  priceMin: number;
  priceMax: number;
  reviewsMin: number;
  reviewsMax: number;
  ratingFilter: number;
  fcl: number;
  alibabaFilters: boolean;
  costBelow: number;
  moq: string;
  alibabaRating: number;
  verifiedSupplier: boolean;
};

type PresetSlot = { id: number; name: string; data: PresetData };
type PresetsStore = { list: PresetSlot[]; counter: number };

function readStore(): PresetsStore {
  try {
    const raw = readFileSync(PRESETS_FILE, 'utf-8');
    return JSON.parse(raw) as PresetsStore;
  } catch {
    return { list: [], counter: 0 };
  }
}

function writeStore(store: PresetsStore) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PRESETS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

// GET — load all presets
export async function GET() {
  const store = readStore();
  return NextResponse.json(store);
}

// POST — save (upsert) a preset
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const store = readStore();

    if (body.action === 'save_new') {
      const nextCounter = store.counter + 1;

      let nextPresetNum = 1;
      const existingNames = new Set(store.list.map(p => p.name));
      while (existingNames.has(`Preset ${nextPresetNum}`)) {
        nextPresetNum++;
      }

      const name = body.name || `Preset ${nextPresetNum}`;
      const newPreset: PresetSlot = {
        id: nextCounter,
        name,
        data: body.data,
      };
      store.list.push(newPreset);
      store.counter = nextCounter;
      writeStore(store);
      logger.info(`Preset saved | Name: "${name}" | ID: ${nextCounter}`);
      return NextResponse.json({ success: true, preset: newPreset, counter: nextCounter });
    }

    if (body.action === 'rename') {
      const { id, name } = body;
      store.list = store.list.map((p) => (p.id === id ? { ...p, name } : p));
      writeStore(store);
      logger.info(`Preset renamed | ID: ${id} | New name: "${name}"`);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    logger.error('Presets POST Error', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE — remove a preset by id
export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();
    const store = readStore();
    store.list = store.list.filter((p) => p.id !== id);
    writeStore(store);
    logger.info(`Preset deleted | ID: ${id}`);
    return NextResponse.json({ success: true });
  } catch (e) {
    logger.error('Presets DELETE Error', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
