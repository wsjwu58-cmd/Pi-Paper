package com.vibepaper.gallery.controller;

import com.vibepaper.gallery.entity.Publication;
import com.vibepaper.gallery.service.GalleryService;
import com.vibepaper.common.api.ApiException;
import com.vibepaper.common.api.ErrorCode;
import com.vibepaper.common.api.PageResult;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequiredArgsConstructor
public class GalleryController {
    private final GalleryService galleryService;

    @GetMapping("/api/v1/gallery/publications")
    public PageResult<Map<String, Object>> listPublic(@RequestParam(defaultValue = "1") int page,
                                                      @RequestParam(defaultValue = "20") int pageSize,
                                                      @RequestParam(required = false) String keyword) {
        return galleryService.listPublic(page, pageSize, keyword);
    }

    @PostMapping("/api/v1/publications")
    public Publication publish(@RequestBody Map<String, Object> body) {
        return galleryService.publish(requiredLong(body.get("canvasId"), "canvasId"),
                body.get("title") == null ? null : body.get("title").toString(),
                body.get("description") == null ? null : body.get("description").toString(),
                body.get("previewAssetUrl") == null ? null : body.get("previewAssetUrl").toString(),
                body.get("previewAssetType") == null ? null : body.get("previewAssetType").toString(),
                body.get("thumbnailUrl") == null ? null : body.get("thumbnailUrl").toString(),
                body.get("shareWorkflow") == null || Boolean.parseBoolean(body.get("shareWorkflow").toString()));
    }

    private Long requiredLong(Object value, String field) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value instanceof String text) {
            try {
                return Long.parseLong(text.trim());
            } catch (NumberFormatException ignored) {
                // Fall through to the public input-validation error below.
            }
        }
        throw ApiException.badRequest(ErrorCode.INVALID_INPUT, field + " 必须是有效的整数");
    }

    @GetMapping("/api/v1/gallery/publications/{id}")
    public Map<String, Object> detail(@PathVariable Long id) {
        return galleryService.detail(id);
    }

    @PostMapping("/api/v1/gallery/publications/{id}/clone")
    public Map<String, Object> clone(@PathVariable Long id) {
        return galleryService.clone(id);
    }

    @DeleteMapping("/api/v1/publications/{id}")
    public Map<String, String> deleteOwn(@PathVariable Long id) {
        galleryService.deleteOwn(id);
        return Map.of("status", "ok");
    }

    // ---- 运营审核 ----
    @GetMapping("/api/v1/publications/admin/list")
    public PageResult<Publication> moderationList(@RequestParam(required = false) String status,
                                                  @RequestParam(defaultValue = "1") int page,
                                                  @RequestParam(defaultValue = "20") int pageSize) {
        return galleryService.moderationList(status, page, pageSize);
    }

    @PostMapping("/api/v1/publications/admin/{id}/{action}")
    public Publication moderate(@PathVariable Long id, @PathVariable String action,
                                @RequestBody(required = false) Map<String, String> body) {
        return galleryService.moderate(id, action, body == null ? null : body.get("reason"));
    }

    @PostMapping("/api/v1/publications/admin/batch")
    public Map<String, Integer> batch(@RequestBody Map<String, Object> body) {
        List<Long> ids = ((List<?>) body.get("ids")).stream().map(v -> ((Number) v).longValue()).toList();
        int count = galleryService.batchModerate(ids, body.get("action").toString(),
                body.get("reason") == null ? null : body.get("reason").toString());
        return Map.of("processed", count);
    }
}
