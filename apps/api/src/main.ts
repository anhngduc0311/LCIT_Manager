import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiExceptionFilter } from './api-contract';
import { AppModule } from './app.module';

async function bootstrap() {
  const host = process.env.API_HOST ?? '127.0.0.1';
  const port = Number(process.env.API_PORT ?? '4000');
  const origins = (
    process.env.API_CORS_ORIGINS ??
    'http://localhost:3000,http://127.0.0.1:3000,http://tauri.localhost'
  ).split(',').map((origin) => origin.trim()).filter(Boolean);

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({ origin: origins, exposedHeaders: ['X-Request-Id'] });
  const config = new DocumentBuilder()
    .setTitle('LCIT Manager API')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'opaque' })
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config));
  await app.listen(port, host);
}

void bootstrap().catch(() => {
  console.error('API startup failed. Check API_HOST, API_PORT and local configuration.');
  process.exitCode = 1;
});
