import { handle } from 'hono/vercel';
import app from './app.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
  memory: 1024,
};

export default handle(app);
