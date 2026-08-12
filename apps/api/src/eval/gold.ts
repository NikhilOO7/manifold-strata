/**
 * Hand-curated gold set for the Gaussian-Splatting domain.
 *
 * This is real, verifiable domain knowledge (3DGS / Mip-Splatting / Scaffold-GS),
 * NOT generated or placeholder data. It is the ground truth the eval harness
 * scores the pipeline against: which entities and relations *should* be found in
 * each passage, which aliases *should* collapse to one canonical node, and what a
 * grounded answer to each question *must* reference.
 *
 * Passages are phrased with explicit relation verbs ("extends", "evaluates on")
 * so the score measures extraction + canonicalization fidelity, not the harness's
 * tolerance for ambiguous phrasing.
 */

export interface ExtractionCase {
  id: string;
  section: string;
  text: string;
  /** Each inner array is the set of accepted surface forms for one gold entity. */
  goldEntities: string[][];
  /** Subject/object given as alias sets; `type` is the canonical edge type. */
  goldRelations: Array<{ subject: string[]; type: string; object: string[] }>;
}

export interface ResolutionCase {
  id: string;
  canonical: string;
  type: 'method' | 'concept' | 'dataset' | 'metric' | 'paper';
  /** All of these should resolve to the canonical node (no new node created). */
  aliases: string[];
  /** Should NOT resolve to the canonical (stays a distinct/new entity). */
  distractors: string[];
}

export interface QACase {
  id: string;
  question: string;
  /** A grounded answer must reference at least one surface form from EACH group. */
  mustMention: string[][];
}

export const DOMAIN_ID = 'gaussian-splatting';

const GS = ['3D Gaussian Splatting', '3DGS', '3D-GS'];
const MIPNERF360 = ['Mip-NeRF360', 'Mip-NeRF 360', 'MipNeRF360'];
const TANKS = ['Tanks and Temples'];
const DEEP_BLENDING = ['Deep Blending'];

export const EXTRACTION_CASES: ExtractionCase[] = [
  {
    id: 'gs-3dgs-abstract',
    section: 'abstract',
    text:
      'We present 3D Gaussian Splatting, a method for real-time radiance field rendering. ' +
      'Starting from the sparse points produced during Structure-from-Motion, we represent ' +
      'the scene with 3D Gaussians and optimize them with a fast differentiable tile-based ' +
      'rasterizer. Our approach achieves real-time rendering at 1080p resolution while matching ' +
      'the visual quality of prior work. We evaluate 3D Gaussian Splatting on the Mip-NeRF360, ' +
      'Tanks and Temples, and Deep Blending datasets, reporting PSNR, SSIM, and LPIPS.',
    goldEntities: [
      GS,
      ['Structure-from-Motion', 'SfM'],
      ['radiance field', 'radiance field rendering', 'radiance fields'],
      ['tile-based rasterizer', 'differentiable rasterizer', 'differentiable rendering'],
      MIPNERF360,
      TANKS,
      DEEP_BLENDING,
      ['PSNR'],
      ['SSIM'],
      ['LPIPS'],
    ],
    goldRelations: [
      { subject: GS, type: 'uses', object: ['Structure-from-Motion', 'SfM'] },
      { subject: GS, type: 'evaluates_on', object: MIPNERF360 },
      { subject: GS, type: 'evaluates_on', object: TANKS },
      { subject: GS, type: 'evaluates_on', object: DEEP_BLENDING },
    ],
  },
  {
    id: 'gs-mip-splatting',
    section: 'abstract',
    text:
      'Mip-Splatting improves 3D Gaussian Splatting by eliminating the aliasing artifacts that ' +
      'appear when the sampling rate changes. We introduce a 3D smoothing filter that constrains ' +
      'the frequency of the 3D Gaussians, together with a 2D Mip filter that replaces the dilation ' +
      'operation. Experiments on the Mip-NeRF360 dataset show consistent improvements across zoom levels.',
    goldEntities: [
      ['Mip-Splatting'],
      GS,
      ['aliasing', 'aliasing artifacts', 'anti-aliasing'],
      ['3D smoothing filter'],
      ['2D Mip filter', 'Mip filter'],
      MIPNERF360,
    ],
    goldRelations: [
      { subject: ['Mip-Splatting'], type: 'improves', object: GS },
      { subject: ['Mip-Splatting'], type: 'introduces', object: ['3D smoothing filter'] },
      { subject: ['Mip-Splatting'], type: 'introduces', object: ['2D Mip filter', 'Mip filter'] },
      { subject: ['Mip-Splatting'], type: 'evaluates_on', object: MIPNERF360 },
    ],
  },
  {
    id: 'gs-scaffold',
    section: 'abstract',
    text:
      'Scaffold-GS extends 3D Gaussian Splatting by using anchor points to distribute local 3D ' +
      'Gaussians and predict their attributes on the fly. It reduces redundant Gaussians and ' +
      'improves rendering speed without sacrificing quality. We evaluate Scaffold-GS on ' +
      'Mip-NeRF360 and Tanks and Temples.',
    goldEntities: [
      ['Scaffold-GS'],
      GS,
      ['anchor points', 'anchors'],
      MIPNERF360,
      TANKS,
    ],
    goldRelations: [
      { subject: ['Scaffold-GS'], type: 'extends', object: GS },
      { subject: ['Scaffold-GS'], type: 'uses', object: ['anchor points', 'anchors'] },
      { subject: ['Scaffold-GS'], type: 'evaluates_on', object: MIPNERF360 },
      { subject: ['Scaffold-GS'], type: 'evaluates_on', object: TANKS },
    ],
  },
];

export const RESOLUTION_CASES: ResolutionCase[] = [
  {
    id: 'res-3dgs',
    canonical: '3D Gaussian Splatting',
    type: 'method',
    aliases: ['3DGS', '3D-GS', '3d gaussian splatting'],
    distractors: ['NeRF', 'Mip-NeRF360'],
  },
  {
    id: 'res-mipnerf360',
    canonical: 'Mip-NeRF360',
    type: 'dataset',
    aliases: ['Mip-NeRF 360', 'MipNeRF360'],
    distractors: ['Tanks and Temples'],
  },
];

export const QA_CASES: QACase[] = [
  {
    id: 'qa-3dgs-datasets',
    question: 'Which datasets is 3D Gaussian Splatting evaluated on?',
    mustMention: [[...MIPNERF360, ...TANKS, ...DEEP_BLENDING]],
  },
  {
    id: 'qa-mip-improves',
    question: 'What does Mip-Splatting improve upon?',
    mustMention: [GS],
  },
];
