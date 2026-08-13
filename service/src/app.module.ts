import { Module } from '@nestjs/common';
import { FlagsModule } from './flags/flags.module';

@Module({
  imports: [FlagsModule],
})
export class AppModule {}
