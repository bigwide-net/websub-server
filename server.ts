import dotenv from 'dotenv';
dotenv.config();

import { startController } from './controller';
import { loadConfig } from './lib/config';

startController(loadConfig()).catch(err => {
    console.error(err);
    process.exit(1);
});
