import { migrate } from '../src/database.js';

await migrate();
console.log('Database migrations are current.');
