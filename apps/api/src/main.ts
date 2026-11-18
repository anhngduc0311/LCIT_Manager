import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiExceptionFilter } from './shared/api-contract';
import { AppModule } from './app.module';
import { DirectDatabaseConnectionRequired, requireDirectDatabaseUrl } from './models/database-config';
import { httpLogging } from './shared/http-logging';

async function bootstrap() {
  if (process.env.DATABASE_URL) requireDirectDatabaseUrl(process.env.DATABASE_URL);
  const host = process.env.API_HOST ?? '127.0.0.1';
  const port = Number(process.env.API_PORT ?? '4000');
  const origins = (
    process.env.API_CORS_ORIGINS ??
    'http://localhost:3000,http://127.0.0.1:3000,http://tauri.localhost'
  ).split(',').map((origin) => origin.trim()).filter(Boolean);

  const app = await NestFactory.create(AppModule);
  app.use(httpLogging());
  app.enableShutdownHooks();
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({ origin: origins, exposedHeaders: ['X-Request-Id', 'Content-Disposition'] });
  const config = new DocumentBuilder()
    .setTitle('LCIT Manager API')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'opaque' })
    .build();
  if (process.env.API_DOCS_ENABLED !== 'off') SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config));
  await app.listen(port, host);
}

void bootstrap().catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const reason = code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
  console.error(error instanceof DirectDatabaseConnectionRequired
    ? error.message
    : `API startup failed${reason}. Check the API and database configuration.`);
  process.exit(1);
});
