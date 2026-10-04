import type { Handler } from '@netlify/functions';
import serverless from 'serverless-http';
import { app } from '../../server.ts';

const expressHandler = serverless(app, { basePath: '/.netlify/functions/api' });

export const handler: Handler = (event, context) =>
  expressHandler(event, context) as ReturnType<Handler>;
