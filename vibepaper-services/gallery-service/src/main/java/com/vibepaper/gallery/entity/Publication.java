package com.vibepaper.gallery.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;

@Data
@TableName("publications")
public class Publication {
    @TableId(type = IdType.INPUT)
    private Long id;
    private Long canvasId;
    private Long ownerId;
    private String title;
    private String description;
    /** pending / published / rejected / taken_down */
    private String status;
    private String thumbnailUrl;
    private String previewAssetUrl;
    private String previewAssetType;
    private Boolean shareWorkflow;
    private String rejectedReason;
    private OffsetDateTime publishedAt;
    private OffsetDateTime createdAt;
}
