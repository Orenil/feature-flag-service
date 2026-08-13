import { Module } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { FlagsController } from './flags.controller';
import { FlagsGateway } from './flags.gateway';
import { FlagsService } from './flags.service';

@Module({
  controllers: [FlagsController],
  providers: [DatabaseService, FlagsGateway, FlagsService],
  exports: [FlagsService],
})
export class FlagsModule {}
