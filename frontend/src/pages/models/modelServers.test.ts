import { describe, expect, it } from 'vitest';
import {
  type HardwareProfile,
  missingAccelerator,
  type ModelServer,
  modelServerLabel,
  modelServerOf,
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
const profile = (resources: string[]): HardwareProfile => ({ name: 'p', label: 'P', description: '', resources });

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
