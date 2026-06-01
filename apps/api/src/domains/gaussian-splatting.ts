import type { DomainConfig } from './types';

export const gaussianSplattingDomain: DomainConfig = {
  id: 'gaussian-splatting',
  name: '3D Gaussian Splatting',
  description:
    'Research on 3D scene reconstruction and novel-view synthesis with Gaussian Splatting and neural radiance fields.',
  entityTypes: ['method', 'concept', 'dataset', 'metric', 'paper_reference'],
  relationshipTypes: [
    'extends',
    'improves',
    'uses',
    'introduces',
    'cites',
    'evaluates_on',
    'compares_to',
  ],
  domainContext:
    'You specialize in computer graphics and 3D reconstruction, particularly Gaussian Splatting and neural radiance fields.',
  entityExamples: {
    method: ['3D Gaussian Splatting', 'NeRF', 'Mip-Splatting', 'Scaffold-GS', 'SLAM', 'SfM'],
    concept: ['view synthesis', 'radiance fields', 'differentiable rendering', 'anti-aliasing'],
    dataset: ['Mip-NeRF360', 'Tanks and Temples', 'DTU', 'LLFF'],
    metric: ['PSNR', 'SSIM', 'LPIPS', 'FPS', 'training time'],
    paper_reference: ['Kerbl et al.', '[1]', 'the original 3DGS paper'],
  },
  relationshipExamples: [
    { source: 'Mip-Splatting', type: 'improves', target: '3D Gaussian Splatting' },
    { source: '3D Gaussian Splatting', type: 'evaluates_on', target: 'Mip-NeRF360' },
  ],
  hierarchicalEdgeTypes: ['extends', 'improves', 'cites'],
  seedPaperIds: [
    '2308.04079', '2308.14737', '2309.16585', '2310.08528', '2311.12775',
    '2311.16099', '2311.17977', '2312.00109', '2312.02126', '2312.03203',
    '2312.07504', '2312.13772', '2401.01339', '2401.02436', '2402.00752',
    '2402.03715', '2402.10259', '2403.02176', '2403.11625', '2403.17888',
    '2404.00109', '2404.01133', '2404.07613', '2405.00121', '2405.12872',
  ],
};
