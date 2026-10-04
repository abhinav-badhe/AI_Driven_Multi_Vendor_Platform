import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Logger } from '../../../observability/logger.js';

const execFileAsync = promisify(execFile);

function findProjectRoot(): string {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(cur, 'ml', 'train.py'))) {
      return cur;
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  const dir = fileURLToPath(new URL('.', import.meta.url));
  cur = dir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'ml', 'train.py'))) {
      return cur;
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

export interface PythonTrainResult {
  success: boolean;
  modelId?: string;
  tenantId?: string;
  modelType?: string;
  version?: string;
  status?: string;
  rejectionReason?: string;
  algorithm?: string;
  hyperparameters?: Record<string, unknown>;
  featureVersion?: string;
  trainingDatasetId?: string;
  dataSourceType?: 'REAL' | 'BOOTSTRAP';
  predictionHorizon?: string;
  metrics?: {
    train: Record<string, number>;
    validation: Record<string, number>;
    test: Record<string, number>;
  };
  sampleCount?: number;
  artifactPath?: string;
  evaluatedAt?: string;
  approvedAt?: string;
  error?: string;
}

export interface PythonPredictResult {
  success: boolean;
  predictions?: Array<{
    entityId: string;
    predictionValue: number;
    probability?: number | null;
    confidence?: number | null;
  }>;
  error?: string;
}

export class PythonRunner {
  private readonly pythonBin: string;
  private readonly projectRoot: string;

  constructor(
    private readonly logger: Logger,
    pythonBin?: string,
    projectRoot?: string,
  ) {
    this.pythonBin = pythonBin ?? process.env.PYTHON_PATH ?? 'python';
    this.projectRoot = projectRoot ?? findProjectRoot();
  }

  async runTraining(config: Record<string, unknown>): Promise<PythonTrainResult> {
    const tempId = randomUUID();
    const inputFile = join(tmpdir(), `ml_train_in_${tempId}.json`);
    const outputFile = join(tmpdir(), `ml_train_out_${tempId}.json`);

    try {
      await fs.writeFile(inputFile, JSON.stringify(config), 'utf-8');

      const trainScript = resolve(this.projectRoot, 'ml/train.py');

      this.logger.info('Executing Python ML training process', {
        pythonBin: this.pythonBin,
        trainScript,
        modelType: config.modelType,
        tenantId: config.tenantId,
      });

      const { stderr } = await execFileAsync(
        this.pythonBin,
        [trainScript, '--input-file', inputFile, '--output-file', outputFile],
        {
          cwd: this.projectRoot,
          env: { ...process.env, PYTHONPATH: this.projectRoot },
          timeout: 45000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      if (stderr && stderr.trim().length > 0) {
        this.logger.debug('Python ML training stderr output', { stderr });
      }

      const outputData = await fs.readFile(outputFile, 'utf-8');
      const parsed = JSON.parse(outputData) as PythonTrainResult;
      return parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('Python ML training execution failed', { error: msg });
      return {
        success: false,
        status: 'FAILED',
        error: msg,
      };
    } finally {
      // Safe cleanup of temporary files
      await Promise.allSettled([
        fs.unlink(inputFile).catch(() => {}),
        fs.unlink(outputFile).catch(() => {}),
      ]);
    }
  }

  async runPrediction(payload: Record<string, unknown>): Promise<PythonPredictResult> {
    const tempId = randomUUID();
    const inputFile = join(tmpdir(), `ml_pred_in_${tempId}.json`);
    const outputFile = join(tmpdir(), `ml_pred_out_${tempId}.json`);

    try {
      await fs.writeFile(inputFile, JSON.stringify(payload), 'utf-8');

      const predictScript = resolve(this.projectRoot, 'ml/predict.py');

      await execFileAsync(
        this.pythonBin,
        [predictScript, '--input-file', inputFile, '--output-file', outputFile],
        {
          cwd: this.projectRoot,
          env: { ...process.env, PYTHONPATH: this.projectRoot },
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const outputData = await fs.readFile(outputFile, 'utf-8');
      const parsed = JSON.parse(outputData) as PythonPredictResult;
      return parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('Python ML prediction execution failed', { error: msg });
      return {
        success: false,
        error: msg,
      };
    } finally {
      await Promise.allSettled([
        fs.unlink(inputFile).catch(() => {}),
        fs.unlink(outputFile).catch(() => {}),
      ]);
    }
  }
}
