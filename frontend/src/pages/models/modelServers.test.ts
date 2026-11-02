import { describe, expect, it } from 'vitest';
import {
  type HardwareProfile,
  missingAccelerator,
  type ModelServer,
  modelServerLabel,
  modelServerOf,
  outOfRange,
  type ProfileResource,
  rangeText,
  serverSuitsText,
} from './modelServers';

const cpu: ModelServer = {
  name: 'v3-6-0-kserve-config-llm-template-cpu',
  label: 'vLLM CPU',
  description: '',
  accelerators: [],
  usesGpus: false,
};
const gpu: ModelServer = {
  name: 'v3-6-0-kserve-config-llm-single-node-template-nvidia-cuda',
  label: 'vLLM NVIDIA GPU',
  description: '',
  accelerators: ['nvidia.com/gpu'],
  usesGpus: true,
};
const profile = (resources: string[]): HardwareProfile => ({
  name: 'p',
  label: 'P',
  description: '',
  resources,
  identifiers: resources.map((identifier) => ({ identifier, label: identifier, min: '1', default: '1' })),
});

describe('modelServerLabel', () => {
  it('names a listed preset by its display name and any other by its name', () => {
    expect(modelServerLabel([cpu.name], [cpu, gpu])).toBe('vLLM CPU');
    expect(modelServerLabel(['custom-preset'], [cpu])).toBe('custom-preset');
    expect(modelServerLabel([cpu.name])).toBe(cpu.name);
    expect(modelServerLabel([])).toBe('');
  });
});

describe('modelServerOf', () => {
  it('lets a model on presets leave its image to them', () => {
    expect(modelServerOf([cpu.name])?.setsImage).toBe(true);
    expect(modelServerOf([])).toBeUndefined();
    expect(modelServerOf(undefined)).toBeUndefined();
  });
});

describe('missingAccelerator', () => {
  it('names the accelerator a GPU server needs and the profile lacks', () => {
    expect(missingAccelerator(gpu, profile(['cpu', 'memory']))).toBe('nvidia.com/gpu');
    expect(missingAccelerator(gpu, profile(['cpu', 'memory', 'nvidia.com/gpu']))).toBeUndefined();
    expect(missingAccelerator(cpu, profile(['cpu', 'memory']))).toBeUndefined();
    expect(missingAccelerator(gpu, undefined)).toBeUndefined();
  });
});

describe('serverSuitsText', () => {
  it('says a GPU server runs only where its accelerator is', () => {
    expect(serverSuitsText(gpu)).toContain('nvidia.com/gpu');
    expect(serverSuitsText(cpu)).toContain('any cluster');
  });
});

describe('profile ranges', () => {
  const memory: ProfileResource = { identifier: 'memory', label: 'Memory', min: '2Gi', default: '4Gi', max: '8Gi' };
  it('accepts a value within the profile range, in any unit, and refuses one outside it', () => {
    expect(outOfRange(memory, '8Gi')).toBeUndefined();
    expect(outOfRange(memory, '4096Mi')).toBeUndefined();
    expect(outOfRange(memory, '16Gi')).toBe('Enter a value from 2Gi to 8Gi.');
    expect(outOfRange(memory, '1Gi')).toBe('Enter a value from 2Gi to 8Gi.');
    expect(outOfRange({ ...memory, max: undefined }, '1Gi')).toBe('Enter a value of at least 2Gi.');
    expect(
      outOfRange({ identifier: 'nvidia.com/gpu', label: 'GPU', min: '1', default: '1', max: '2' }, '4', 'number'),
    ).toBe('Enter a number from 1 to 2.');
  });
  it('leaves a resource the profile does not set, or an unparsed value, to the field', () => {
    expect(outOfRange(undefined, '64Gi')).toBeUndefined();
    expect(outOfRange(memory, 'lots')).toBeUndefined();
  });
  it('says the range as help', () => {
    expect(rangeText(memory)).toBe('From 2Gi to 8Gi.');
    expect(rangeText({ ...memory, max: undefined })).toBe('At least 2Gi.');
  });
});
