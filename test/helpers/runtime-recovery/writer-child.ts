import { SyntheticRecoveryDriver } from './driver.ts';

const driver = new SyntheticRecoveryDriver(process.argv[2]);
try {
  driver.begin(JSON.parse(process.argv[3]));
  process.stdout.write('writer_acquired\n');
} finally {
  driver.close();
}
