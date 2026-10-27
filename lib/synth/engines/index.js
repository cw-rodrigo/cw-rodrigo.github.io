// Registro dos motores de síntese (cada um é um módulo independente).
import subtractive from './subtractive.js';
import additive from './additive.js';
import fm from './fm.js';
import am from './am.js';
import wavetable from './wavetable.js';
import pd from './pd.js';
import formant from './formant.js';
import granular from './granular.js';
import physical from './physical.js';
import sampler from './sampler.js';
import drums from './drums.js';
import nes from './nes.js';

export const FACTORIES = { subtractive, additive, fm, am, wavetable, pd, formant, granular, physical, sampler, drums, nes };
