import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetFaceCreateDto,
  AssetFaceDeleteDto,
  AssetFaceResponseDto,
  FaceDto,
  PersonResponseDto,
} from 'src/dtos/person.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { PersonService } from 'src/services/person.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Faces)
@Controller('faces')
export class FaceController {
  constructor(private service: PersonService) {}

  @Post()
  @Authenticated({ permission: Permission.FaceCreate })
  @Endpoint({
    summary: 'Create a face',
    description:
      'Create a new face that has not been discovered by facial recognition. The content of the bounding box is considered a face.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createFace(@Auth() auth: AuthDto, @Body() dto: AssetFaceCreateDto) {
    return this.service.createFace(auth, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.FaceRead })
  @Endpoint({
    summary: 'Retrieve faces for asset',
    description: 'Retrieve all faces belonging to an asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getFaces(@Auth() auth: AuthDto, @Query() dto: FaceDto): Promise<AssetFaceResponseDto[]> {
    return this.service.getFacesById(auth, dto);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.FaceUpdate })
  @Endpoint({
    summary: 'Re-assign a face to another person',
    description: 'Re-assign the face provided in the body to the person identified by the id in the path parameter.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  reassignFacesById(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: FaceDto,
  ): Promise<PersonResponseDto> {
    return this.service.reassignFacesById(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.FaceDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a face',
    description: 'Delete a face identified by the id. Optionally can be force deleted.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteFace(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: AssetFaceDeleteDto): Promise<void> {
    return this.service.deleteFace(auth, id, dto);
  }

  @Get(':id/thumbnail')
  @Authenticated({ permission: Permission.FaceRead })
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'private, max-age=86400')
  @Endpoint({
    summary: 'Get a face thumbnail',
    description: 'Return a cropped JPEG centered on the face bounding box of the given face.',
    history: new HistoryBuilder().added('v1'),
  })
  async getFaceThumbnail(
    @Res() res: Response,
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<void> {
    const buffer = await this.service.getFaceThumbnailBuffer(auth, id);
    res.send(buffer);
  }
}
