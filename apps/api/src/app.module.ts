import { Module } from '@nestjs/common';
import { AttachmentsController, PermissionsController } from './controllers/attachments.controller';
import { AuditController } from './controllers/audit.controller';
import { AuthController } from './controllers/auth.controller';
import { ApplicationDatabasesController, catalogControllers } from './controllers/catalog.controller';
import { HealthController } from './controllers/health.controller';
import { infrastructureControllers } from './controllers/infrastructure.controller';
import { SearchController } from './controllers/search.controller';
import { UsersController } from './controllers/users.controller';
import { SessionGuard } from './guards/session.guard';
import { AttachmentsService } from './models/attachments.service';
import { AuditService } from './models/audit.service';
import { FileStore } from './models/file-store';
import { PermissionsService } from './models/permissions.service';
import { AuthService } from './models/auth.service';
import { CatalogService } from './models/catalog.service';
import { Database } from './models/database';
import { InfrastructureService } from './models/infrastructure.service';
import { SearchService } from './models/search.service';
import { UsersService } from './models/users.service';

@Module({
  controllers: [HealthController, AuthController, UsersController, AuditController, ...catalogControllers, ApplicationDatabasesController,
    ...infrastructureControllers, SearchController, AttachmentsController, PermissionsController],
  providers: [Database, AuditService, AuthService, UsersService, CatalogService, SessionGuard, InfrastructureService, SearchService,
    FileStore, PermissionsService, AttachmentsService],
})
export class AppModule {}
