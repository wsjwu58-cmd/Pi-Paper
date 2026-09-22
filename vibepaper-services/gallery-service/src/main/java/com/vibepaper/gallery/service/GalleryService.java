package com.vibepaper.gallery.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.vibepaper.common.api.ApiException;
import com.vibepaper.common.api.ErrorCode;
import com.vibepaper.common.api.PageResult;
import com.vibepaper.common.context.RequestContext;
import com.vibepaper.common.id.SnowflakeIdGenerator;
import com.vibepaper.gallery.entity.CanvasSnapshot;
import com.vibepaper.gallery.entity.ModerationRecord;
import com.vibepaper.gallery.entity.Publication;
import com.vibepaper.gallery.feign.CanvasInternalClient;
import com.vibepaper.gallery.feign.IdentityInternalClient;
import com.vibepaper.gallery.mapper.CanvasSnapshotMapper;
import com.vibepaper.gallery.mapper.ModerationRecordMapper;
import com.vibepaper.gallery.mapper.PublicationMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 创意广场（P1｜F-24/B-24）：先审后发；发布即快照，原画布修改不影响已发布内容。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class GalleryService {
    private final PublicationMapper publicationMapper;
    private final CanvasSnapshotMapper snapshotMapper;
    private final ModerationRecordMapper moderationMapper;
    private final SnowflakeIdGenerator idGenerator;
    private final CanvasInternalClient canvasClient;
    private final IdentityInternalClient identityClient;

    @Transactional
    public Publication publish(Long canvasId, String title, String description, String previewAssetUrl,
                               String previewAssetType, String thumbnailUrl, boolean shareWorkflow) {
        Long userId = RequestContext.userIdLong();
        Map<String, Object> export;
        try {
            export = canvasClient.exportCanvas(canvasId);
        } catch (Exception e) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "无法获取画布数据: " + e.getMessage());
        }
        Publication pub = new Publication();
        pub.setId(idGenerator.nextId());
        pub.setCanvasId(canvasId);
        pub.setOwnerId(userId);
        if (title == null || title.isBlank() || description == null || description.isBlank()) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "项目名称和作品描述均为必填项");
        }
        pub.setTitle(limit(title, 128, "项目名称"));
        pub.setDescription(limit(description, 1000, "作品描述"));
        pub.setPreviewAssetUrl(limitOptional(previewAssetUrl, 2048, "作品文件地址"));
        pub.setPreviewAssetType(validPreviewType(previewAssetType));
        pub.setThumbnailUrl(limitOptional(thumbnailUrl, 2048, "封面地址"));
        pub.setShareWorkflow(shareWorkflow);
        pub.setStatus("pending");
        pub.setCreatedAt(OffsetDateTime.now());
        publicationMapper.insert(pub);

        CanvasSnapshot snapshot = new CanvasSnapshot();
        snapshot.setId(idGenerator.nextId());
        snapshot.setPublicationId(pub.getId());
        snapshot.setCanvasId(canvasId);
        snapshot.setPayload(writeJson(export));
        snapshot.setCreatedAt(OffsetDateTime.now());
        snapshotMapper.insert(snapshot);
        log.info("publication submitted id={} canvas={} user={}", pub.getId(), canvasId, userId);
        return pub;
    }

    public PageResult<Map<String, Object>> listPublic(int page, int pageSize, String keyword) {
        Page<Publication> p = publicationMapper.selectPage(new Page<>(page, pageSize),
                new LambdaQueryWrapper<Publication>()
                        .eq(Publication::getStatus, "published")
                        .like(keyword != null && !keyword.isBlank(), Publication::getTitle, keyword)
                        .orderByDesc(Publication::getPublishedAt));
        return PageResult.of(p.getRecords().stream().map(this::toView).toList(), p.getTotal(), page, pageSize);
    }

    public Map<String, Object> detail(Long publicationId) {
        Publication pub = publicationMapper.selectById(publicationId);
        if (pub == null) {
            throw ApiException.notFound("作品不存在");
        }
        if (!"published".equals(pub.getStatus())) {
            Long userId = RequestContext.userIdLong();
            if (userId == null || !pub.getOwnerId().equals(userId)) {
                throw ApiException.forbidden("该作品未公开");
            }
        }
        CanvasSnapshot snapshot = snapshotMapper.selectOne(new LambdaQueryWrapper<CanvasSnapshot>()
                .eq(CanvasSnapshot::getPublicationId, publicationId));
        Map<String, Object> view = new HashMap<>(toView(pub));
        if (snapshot != null && (Boolean.TRUE.equals(pub.getShareWorkflow()) || isOwner(pub))) {
            view.put("snapshot", parse(snapshot.getPayload()));
        }
        return view;
    }

    @Transactional
    public Map<String, Object> clone(Long publicationId) {
        Long userId = RequestContext.userIdLong();
        Publication pub = publicationMapper.selectById(publicationId);
        if (pub == null || !"published".equals(pub.getStatus()) || !Boolean.TRUE.equals(pub.getShareWorkflow())) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "仅可克隆已发布作品");
        }
        CanvasSnapshot snapshot = snapshotMapper.selectOne(new LambdaQueryWrapper<CanvasSnapshot>()
                .eq(CanvasSnapshot::getPublicationId, publicationId));
        if (snapshot == null) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "作品快照不存在");
        }
        Map<String, Object> result = canvasClient.importCanvas(Map.of("ownerId", userId, "json", snapshot.getPayload()));
        log.info("publication cloned pub={} user={} newCanvas={}", publicationId, userId, result.get("canvasId"));
        return result;
    }

    @Transactional
    public void deleteOwn(Long publicationId) {
        Long userId = RequestContext.userIdLong();
        Publication pub = publicationMapper.selectById(publicationId);
        if (pub == null) {
            throw ApiException.notFound("作品不存在");
        }
        if (!pub.getOwnerId().equals(userId)) {
            throw ApiException.forbidden("只能删除自己的作品");
        }
        publicationMapper.deleteById(publicationId);
    }

    public PageResult<Publication> moderationList(String status, int page, int pageSize) {
        Page<Publication> p = publicationMapper.selectPage(new Page<>(page, pageSize),
                new LambdaQueryWrapper<Publication>()
                        .eq(status != null && !status.isBlank(), Publication::getStatus, status)
                        .orderByAsc(Publication::getCreatedAt));
        return PageResult.of(p.getRecords(), p.getTotal(), page, pageSize);
    }

    @Transactional
    public Publication moderate(Long publicationId, String action, String reason) {
        if (!RequestContext.isAdmin()) {
            throw ApiException.forbidden("仅运营管理员可审核");
        }
        Publication pub = publicationMapper.selectById(publicationId);
        if (pub == null) {
            throw ApiException.notFound("作品不存在");
        }
        switch (action) {
            case "approve" -> {
                pub.setStatus("published");
                pub.setPublishedAt(OffsetDateTime.now());
            }
            case "reject" -> {
                pub.setStatus("rejected");
                pub.setRejectedReason(reason);
            }
            case "take_down" -> pub.setStatus("taken_down");
            default -> throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "审核动作必须是 approve/reject/take_down");
        }
        publicationMapper.updateById(pub);
        ModerationRecord record = new ModerationRecord();
        record.setId(idGenerator.nextId());
        record.setPublicationId(publicationId);
        record.setOperatorId(RequestContext.userIdLong());
        record.setAction(action);
        record.setReason(reason);
        record.setCreatedAt(OffsetDateTime.now());
        moderationMapper.insert(record);
        log.info("moderation pub={} action={} operator={}", publicationId, action, RequestContext.userIdLong());
        return pub;
    }

    @Transactional
    public int batchModerate(List<Long> ids, String action, String reason) {
        int count = 0;
        for (Long id : ids) {
            try {
                moderate(id, action, reason);
                count++;
            } catch (Exception e) {
                log.warn("batch moderate skip pub={}: {}", id, e.getMessage());
            }
        }
        return count;
    }

    private Map<String, Object> toView(Publication pub) {
        Map<String, Object> view = new HashMap<>();
        view.put("id", pub.getId());
        view.put("canvasId", pub.getCanvasId());
        view.put("ownerId", pub.getOwnerId());
        view.put("title", pub.getTitle());
        view.put("description", pub.getDescription());
        view.put("status", pub.getStatus());
        view.put("thumbnailUrl", pub.getThumbnailUrl());
        view.put("previewAssetUrl", pub.getPreviewAssetUrl());
        view.put("previewAssetType", pub.getPreviewAssetType());
        view.put("shareWorkflow", Boolean.TRUE.equals(pub.getShareWorkflow()));
        view.put("rejectedReason", pub.getRejectedReason());
        view.put("publishedAt", pub.getPublishedAt() == null ? null : pub.getPublishedAt().toString());
        view.put("createdAt", pub.getCreatedAt() == null ? null : pub.getCreatedAt().toString());
        try {
            Map<String, Object> user = identityClient.getUser(pub.getOwnerId());
            view.put("authorName", user.get("nickname"));
            view.put("authorAvatar", user.get("avatarUrl"));
        } catch (Exception e) {
            view.put("authorName", "创作者");
        }
        return view;
    }

    private Map<String, Object> parse(String json) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = new com.fasterxml.jackson.databind.ObjectMapper().readValue(json, Map.class);
            return map;
        } catch (Exception e) {
            return Map.of();
        }
    }

    private String writeJson(Object obj) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(obj);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private boolean isOwner(Publication pub) {
        Long userId = RequestContext.userIdLong();
        return userId != null && pub.getOwnerId().equals(userId);
    }

    private String limit(String value, int max, String field) {
        String trimmed = value.trim();
        if (trimmed.length() > max) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, field + "最多" + max + "个字符");
        }
        return trimmed;
    }

    private String limitOptional(String value, int max, String field) {
        if (value == null || value.isBlank()) {
            return null;
        }
        return limit(value, max, field);
    }

    private String validPreviewType(String type) {
        if (type == null || type.isBlank()) {
            return null;
        }
        if (!List.of("image", "video", "audio").contains(type)) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "作品文件类型无效");
        }
        return type;
    }
}
