import { Module } from '@nestjs/common';
import { SessionGuard } from './access';
import { AuditController } from './audit';
import { AuthController, AuthService } from './auth';
import { ApplicationDatabasesController, catalogControllers, CatalogService } from './catalog';
import { Database } from './database';
import { HealthController } from './health.controller';
import { infrastructureControllers, InfrastructureService } from './infrastructure';
import { SearchController, SearchService } from './search';
import { UsersController, UsersService } from './users';

@Module({
  controllers: [HealthController, AuthController, UsersController, AuditController, ...catalogControllers, ApplicationDatabasesController,
    ...infrastructureControllers, SearchController],
  providers: [Database, AuthService, UsersService, CatalogService, SessionGuard, InfrastructureService, SearchService],
})
export class AppModule {}
