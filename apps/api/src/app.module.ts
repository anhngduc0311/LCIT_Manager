import { Module } from '@nestjs/common';
import { Database } from './database';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [Database],
})
export class AppModule {}
