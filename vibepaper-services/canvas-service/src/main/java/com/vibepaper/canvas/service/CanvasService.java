package com.vibepaper.canvas.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.vibepaper.canvas.domain.EdgeRules;
import com.vibepaper.canvas.dto.CanvasDtos;
import com.vibepaper.canvas.entity.*;
import com.vibepaper.canvas.mapper.*;
import com.vibepaper.common.api.ApiException;
import com.vibepaper.common.api.ErrorCode;
import com.vibepaper.common.api.PageResult;
import com.vibepaper.common.context.RequestContext;
import com.vibepaper.common.id.SnowflakeIdGenerator;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class CanvasService {
    public static final String CURRENT_SCHEMA_VERSION = "1.0.0";

    private final CanvasMapper canvasMapper;
    private final CanvasNodeMapper nodeMapper;
    private final CanvasEdgeMapper edgeMapper;
    private final CanvasGroupMapper groupMapper;
    private final CanvasStackMapper stackMapper;
    private final CanvasRevisionMapper revisionMapper;
    private final CanvasShareMapper shareMapper;
    private final CanvasGraphCommandMapper graphCommandMapper;
    private final SnowflakeIdGenerator idGenerator;
    private final ObjectMapper objectMapper;

    @Transactional
    public CanvasDtos.CanvasView create(CanvasDtos.CreateCanvasRequest req) {
        return createForInternal(req, RequestContext.userIdLong());
    }

    @Transactional
    public CanvasDtos.CanvasView createForInternal(CanvasDtos.CreateCanvasRequest req, Long ownerId) {
        Canvas canvas = new Canvas();
        canvas.setId(idGenerator.nextId());
        canvas.setOwnerId(ownerId);
        canvas.setName(req.name());
        canvas.setDescription(req.description());
        canvas.setSchemaVersion(CURRENT_SCHEMA_VERSION);
        canvas.setVersion(1);
        canvas.setVisibility("private");
        canvas.setShareToken(UUID.randomUUID().toString().replace("-", ""));
        canvas.setDeleted(false);
        canvas.setCreatedAt(OffsetDateTime.now());
        canvas.setUpdatedAt(OffsetDateTime.now());
        canvasMapper.insert(canvas);
        return toView(canvas);
    }

    public PageResult<CanvasDtos.CanvasView> list(int page, int pageSize, String keyword) {
        Long userId = RequestContext.userIdLong();
        Page<Canvas> p = canvasMapper.selectPage(new Page<>(page, pageSize),
                new LambdaQueryWrapper<Canvas>()
                        .eq(Canvas::getOwnerId, userId)
                        .like(keyword != null && !keyword.isBlank(), Canvas::getName, keyword)
                        .orderByDesc(Canvas::getUpdatedAt));
        return PageResult.of(toListViews(p.getRecords()), p.getTotal(), page, pageSize);
    }

    public CanvasDtos.CanvasDetail detail(Long canvasId) {
        Canvas canvas = requireOwned(canvasId);
        return buildDetail(canvas);
    }

    public CanvasDtos.CanvasView update(Long canvasId, CanvasDtos.UpdateCanvasRequest req) {
        Canvas canvas = requireOwned(canvasId);
        if (req.name() != null && !req.name().isBlank()) {
            canvas.setName(req.name());
        }
        if (req.description() != null) {
            canvas.setDescription(req.description());
        }
        if (req.thumbnailUrl() != null) {
            canvas.setThumbnailUrl(req.thumbnailUrl());
        }
        canvas.setUpdatedAt(OffsetDateTime.now());
        canvasMapper.updateById(canvas);
        return toView(canvas);
    }

    @Transactional
    public void delete(Long canvasId) {
        Canvas canvas = requireOwned(canvasId);
        canvasMapper.deleteById(canvasId);
        nodeMapper.delete(new LambdaQueryWrapper<CanvasNode>().eq(CanvasNode::getCanvasId, canvasId));
        edgeMapper.delete(new LambdaQueryWrapper<CanvasEdge>().eq(CanvasEdge::getCanvasId, canvasId));
        groupMapper.delete(new LambdaQueryWrapper<CanvasGroup>().eq(CanvasGroup::getCanvasId, canvasId));
        stackMapper.delete(new LambdaQueryWrapper<CanvasStack>().eq(CanvasStack::getCanvasId, canvasId));
    }

    @Transactional
    public CanvasDtos.CanvasDetail save(Long canvasId, CanvasDtos.SaveCanvasRequest req, String idempotencyKey) {
        // A full save replaces every graph row. Lock the canvas before reading
        // its version so Agent graph commands cannot interleave an insert into
        // the delete/reinsert window.
        Canvas canvas = requireOwnedForUpdate(canvasId);
        CanvasGraphCommand replay = claimGraphCommand(canvasId, idempotencyKey, "save_canvas");
        if (replay.getResultSnapshot() != null && !"{}".equals(replay.getResultSnapshot())) {
            try {
                return objectMapper.readValue(replay.getResultSnapshot(), CanvasDtos.CanvasDetail.class);
            } catch (Exception e) {
                throw new IllegalStateException("画布保存命令结果快照损坏", e);
            }
        }
        if (!canvas.getVersion().equals(req.version())) {
            log.warn("canvas save version conflict canvasId={} currentVersion={} requestVersion={}",
                    canvasId, canvas.getVersion(), req.version());
            throw ApiException.conflict(ErrorCode.VERSION_CONFLICT, "画布已在其他会话更新，请刷新");
        }

        List<CanvasNode> previousNodes = nodeMapper.selectList(
                new LambdaQueryWrapper<CanvasNode>().eq(CanvasNode::getCanvasId, canvasId));
        Map<Long, CanvasNode> previousById = previousNodes.stream()
                .collect(Collectors.toMap(CanvasNode::getId, n -> n, (a, b) -> a));

        // 全量替换节点/连线/编组/堆叠。图实体启用了逻辑删除，但保存
        // 会复用客户端传来的稳定 ID；必须物理删除旧行，否则同 ID 重插
        // 会触发主键冲突并被网关映射成 CANVAS_UNAVAILABLE。
        nodeMapper.hardDeleteByCanvasId(canvasId);
        edgeMapper.hardDeleteByCanvasId(canvasId);
        groupMapper.hardDeleteByCanvasId(canvasId);
        stackMapper.hardDeleteByCanvasId(canvasId);
        nodeMapper.delete(new LambdaQueryWrapper<CanvasNode>().eq(CanvasNode::getCanvasId, canvasId));
        edgeMapper.delete(new LambdaQueryWrapper<CanvasEdge>().eq(CanvasEdge::getCanvasId, canvasId));
        groupMapper.delete(new LambdaQueryWrapper<CanvasGroup>().eq(CanvasGroup::getCanvasId, canvasId));
        stackMapper.delete(new LambdaQueryWrapper<CanvasStack>().eq(CanvasStack::getCanvasId, canvasId));

        Set<Long> nodeIds = new HashSet<>();
        if (req.nodes() != null) {
            for (CanvasDtos.NodePayload n : req.nodes()) {
                if (!EdgeRules.isValidNodeType(n.type())) {
                    throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "非法节点类型: " + n.type());
                }
                CanvasNode node = new CanvasNode();
                node.setId(n.id());
                node.setCanvasId(canvasId);
                node.setNodeType(n.type());
                node.setPositionX(n.x());
                node.setPositionY(n.y());
                node.setWidth(n.width());
                node.setHeight(n.height());
                node.setParams(n.params() == null ? "{}" : writeJson(n.params()));
                node.setStatus(n.status() == null ? "idle" : n.status());
                node.setCreativeType(n.creativeType());
                node.setStale(Boolean.TRUE.equals(n.stale()));
                node.setModelRef(n.modelRef());
                node.setPrompt(n.prompt());
                node.setExecStatus(n.execStatus() == null ? "idle" : n.execStatus());
                if (n.output() != null && !n.output().isEmpty()) {
                    node.setOutput(writeJson(n.output()));
                }
                applyPreservedGeneration(node, n, previousById.get(n.id()));
                node.setCurrentOutputId(n.currentOutputId());
                node.setGroupId(n.groupId());
                node.setStackId(n.stackId());
                node.setDeleted(false);
                node.setCreatedAt(OffsetDateTime.now());
                node.setUpdatedAt(OffsetDateTime.now());
                nodeMapper.insert(node);
                nodeIds.add(n.id());
            }
        }

        Set<Long> validNodeIds = nodeIds;
        if (req.edges() != null) {
            for (CanvasDtos.EdgePayload e : req.edges()) {
                if (!validNodeIds.contains(e.sourceNodeId()) || !validNodeIds.contains(e.targetNodeId())) {
                    continue;
                }
                CanvasNode source = nodeMapper.selectById(e.sourceNodeId());
                CanvasNode target = nodeMapper.selectById(e.targetNodeId());
                boolean compatible = source != null && target != null
                        && EdgeRules.isCompatible(source.getNodeType(), target.getNodeType());
                CanvasEdge edge = new CanvasEdge();
                edge.setId(e.id());
                edge.setCanvasId(canvasId);
                edge.setSourceNodeId(e.sourceNodeId());
                edge.setSourcePort(e.sourcePort() == null ? "output" : e.sourcePort());
                edge.setTargetNodeId(e.targetNodeId());
                edge.setTargetPort(e.targetPort() == null ? "input" : e.targetPort());
                edge.setValid(e.valid() == null ? compatible : e.valid() && compatible);
                edge.setDependencyType(e.dependencyType() == null ? "reference" : e.dependencyType());
                edge.setDeleted(false);
                edge.setCreatedAt(OffsetDateTime.now());
                edge.setUpdatedAt(OffsetDateTime.now());
                edgeMapper.insert(edge);
            }
        }
        if (req.groups() != null) {
            for (CanvasDtos.GroupPayload g : req.groups()) {
                CanvasGroup group = new CanvasGroup();
                group.setId(g.id());
                group.setCanvasId(canvasId);
                group.setName(g.name() == null ? "编组" : g.name());
                group.setColor(g.color() == null ? "#8b5cf6" : g.color());
                group.setLayout(g.layout() == null ? "free" : g.layout());
                group.setNodeIds(g.nodeIds() == null ? List.of() : g.nodeIds());
                group.setDeleted(false);
                group.setCreatedAt(OffsetDateTime.now());
                group.setUpdatedAt(OffsetDateTime.now());
                groupMapper.insert(group);
            }
        }
        if (req.stacks() != null) {
            for (CanvasDtos.StackPayload s : req.stacks()) {
                CanvasStack stack = new CanvasStack();
                stack.setId(s.id());
                stack.setCanvasId(canvasId);
                stack.setCollapsed(s.collapsed() == null || s.collapsed());
                stack.setNodeIds(s.nodeIds() == null ? List.of() : s.nodeIds());
                stack.setDeleted(false);
                stack.setCreatedAt(OffsetDateTime.now());
                stack.setUpdatedAt(OffsetDateTime.now());
                stackMapper.insert(stack);
            }
        }

        // 乐观锁：使用显式 version 条件更新。Canvas 标注了 @Version，
        // 因而不能先把实体 version 手动加一再调用 updateById（插件会
        // 把已加一的值当作旧版本，导致永远更新 0 行）。
        int currentVersion = canvas.getVersion();
        int nextVersion = currentVersion + 1;
        OffsetDateTime now = OffsetDateTime.now();
        int updated = canvasMapper.update(null, new LambdaUpdateWrapper<Canvas>()
                .eq(Canvas::getId, canvasId)
                .eq(Canvas::getVersion, currentVersion)
                .set(Canvas::getVersion, nextVersion)
                .set(Canvas::getUpdatedAt, now));
        if (updated == 0) {
            throw ApiException.conflict(ErrorCode.VERSION_CONFLICT, "画布已在其他会话更新，请刷新");
        }
        canvas.setVersion(nextVersion);
        canvas.setUpdatedAt(now);

        CanvasRevision revision = new CanvasRevision();
        revision.setId(idGenerator.nextId());
        revision.setCanvasId(canvasId);
        revision.setVersion(canvas.getVersion());
        revision.setPayload(writeJson(buildDetail(canvas).nodes()));
        revision.setCreatedAt(OffsetDateTime.now());
        revisionMapper.insert(revision);

        CanvasDtos.CanvasDetail result = buildDetail(canvas);
        try {
            replay.setResultCanvasVersion(canvas.getVersion());
            replay.setResultSnapshot(objectMapper.writeValueAsString(result));
            graphCommandMapper.updateById(replay);
        } catch (Exception e) {
            throw new IllegalStateException("画布保存命令结果快照写入失败", e);
        }
        return result;
    }

    public Map<String, Object> export(Long canvasId) {
        Canvas canvas = requireOwned(canvasId);
        return buildExportDoc(canvas);
    }

    public Map<String, Object> exportInternalForOwner(Long canvasId) {
        Canvas canvas = canvasMapper.selectById(canvasId);
        if (canvas == null) {
            throw ApiException.notFound("画布不存在");
        }
        return buildExportDoc(canvas);
    }

    private Map<String, Object> buildExportDoc(Canvas canvas) {
        CanvasDtos.CanvasDetail detail = buildDetail(canvas);
        Map<String, Object> doc = new HashMap<>();
        doc.put("schema_version", CURRENT_SCHEMA_VERSION);
        doc.put("schemaVersion", CURRENT_SCHEMA_VERSION);
        doc.put("canvas", detail.canvas());
        doc.put("nodes", detail.nodes());
        doc.put("edges", detail.edges());
        doc.put("groups", detail.groups());
        doc.put("stacks", detail.stacks());
        return doc;
    }

    @Transactional
    public CanvasDtos.CanvasDetail importCanvas(String json, Long ownerId) {
        Map<String, Object> doc;
        try {
            doc = objectMapper.readValue(json, new TypeReference<>() {
            });
        } catch (Exception e) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "画布 JSON 格式错误: " + e.getMessage());
        }
        Object schemaVer = doc.get("schema_version");
        if (schemaVer == null) {
            schemaVer = doc.get("schemaVersion");
        }
        if (schemaVer == null) {
            throw ApiException.badRequest(ErrorCode.SCHEMA_INCOMPATIBLE, "缺少 schema_version，导入拒绝");
        }
        String version = schemaVer.toString();
        if (!isSchemaCompatible(version)) {
            throw ApiException.badRequest(ErrorCode.SCHEMA_INCOMPATIBLE,
                    "画布版本不兼容：导入版本 " + version + "，当前最低兼容 " + CURRENT_SCHEMA_VERSION);
        }

        Canvas canvas = new Canvas();
        canvas.setId(idGenerator.nextId());
        canvas.setOwnerId(ownerId == null ? RequestContext.userIdLong() : ownerId);
        Map<String, Object> canvasInfo = (Map<String, Object>) doc.getOrDefault("canvas", Map.of());
        canvas.setName(canvasInfo.get("name") == null ? "导入的画布" : canvasInfo.get("name").toString());
        canvas.setDescription(canvasInfo.get("description") == null ? null : canvasInfo.get("description").toString());
        canvas.setSchemaVersion(CURRENT_SCHEMA_VERSION);
        canvas.setVersion(1);
        canvas.setVisibility("private");
        canvas.setShareToken(UUID.randomUUID().toString().replace("-", ""));
        canvas.setDeleted(false);
        canvas.setCreatedAt(OffsetDateTime.now());
        canvas.setUpdatedAt(OffsetDateTime.now());
        canvasMapper.insert(canvas);

        Map<String, Long> idMap = new HashMap<>();
        List<Map<String, Object>> nodes = (List<Map<String, Object>>) doc.getOrDefault("nodes", List.of());
        for (Map<String, Object> n : nodes) {
            Long oldId = ((Number) n.get("id")).longValue();
            Long newId = idGenerator.nextId();
            idMap.put(oldId.toString(), newId);
            CanvasNode node = new CanvasNode();
            node.setId(newId);
            node.setCanvasId(canvas.getId());
            node.setNodeType(n.get("type").toString());
            node.setPositionX(n.get("x") == null ? 100 : ((Number) n.get("x")).doubleValue());
            node.setPositionY(n.get("y") == null ? 100 : ((Number) n.get("y")).doubleValue());
            node.setWidth(n.get("width") == null ? 260 : ((Number) n.get("width")).doubleValue());
            node.setHeight(n.get("height") == null ? 200 : ((Number) n.get("height")).doubleValue());
            node.setParams(n.get("params") == null ? "{}" : writeJson(n.get("params")));
            node.setStatus("idle");
            Object ct = n.get("creativeType");
            if (ct == null) {
                ct = n.get("creative_type");
            }
            node.setCreativeType(ct == null ? null : ct.toString());
            node.setStale(false);
            node.setDeleted(false);
            node.setCreatedAt(OffsetDateTime.now());
            node.setUpdatedAt(OffsetDateTime.now());
            nodeMapper.insert(node);
        }

        List<Map<String, Object>> edges = (List<Map<String, Object>>) doc.getOrDefault("edges", List.of());
        for (Map<String, Object> e : edges) {
            Long newSource = idMap.get(String.valueOf(((Number) e.get("sourceNodeId")).longValue()));
            Long newTarget = idMap.get(String.valueOf(((Number) e.get("targetNodeId")).longValue()));
            if (newSource == null || newTarget == null) {
                continue;
            }
            CanvasNode source = nodeMapper.selectById(newSource);
            CanvasNode target = nodeMapper.selectById(newTarget);
            CanvasEdge edge = new CanvasEdge();
            edge.setId(idGenerator.nextId());
            edge.setCanvasId(canvas.getId());
            edge.setSourceNodeId(newSource);
            edge.setSourcePort(e.get("sourcePort") == null ? "output" : e.get("sourcePort").toString());
            edge.setTargetNodeId(newTarget);
            edge.setTargetPort(e.get("targetPort") == null ? "input" : e.get("targetPort").toString());
            edge.setValid(source != null && target != null
                    && EdgeRules.isCompatible(source.getNodeType(), target.getNodeType()));
            Object dep = e.get("dependencyType");
            if (dep == null) {
                dep = e.get("dependency_type");
            }
            edge.setDependencyType(dep == null ? "reference" : dep.toString());
            edge.setDeleted(false);
            edge.setCreatedAt(OffsetDateTime.now());
            edge.setUpdatedAt(OffsetDateTime.now());
            edgeMapper.insert(edge);
        }
        return buildDetail(canvas);
    }

    @Transactional
    public CanvasDtos.CanvasDetail share(Long canvasId, CanvasDtos.ShareRequest req) {
        Canvas canvas = requireOwned(canvasId);
        String visibility = req.visibility();
        if (!Set.of("private", "link", "public").contains(visibility)) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "共享状态必须是 private/link/public");
        }
        canvas.setVisibility(visibility);
        canvas.setUpdatedAt(OffsetDateTime.now());
        canvasMapper.updateById(canvas);
        CanvasShare share = shareMapper.selectOne(new LambdaQueryWrapper<CanvasShare>().eq(CanvasShare::getCanvasId, canvasId));
        if (share == null) {
            share = new CanvasShare();
            share.setId(idGenerator.nextId());
            share.setCanvasId(canvasId);
            share.setToken(UUID.randomUUID().toString().replace("-", ""));
            share.setVisibility(visibility);
            share.setCreatedAt(OffsetDateTime.now());
            share.setUpdatedAt(OffsetDateTime.now());
            shareMapper.insert(share);
        } else {
            share.setVisibility(visibility);
            share.setUpdatedAt(OffsetDateTime.now());
            shareMapper.updateById(share);
        }
        return buildDetail(canvas);
    }

    public CanvasDtos.CanvasDetail viewShared(String token) {
        CanvasShare share = shareMapper.selectOne(new LambdaQueryWrapper<CanvasShare>().eq(CanvasShare::getToken, token));
        if (share == null) {
            throw ApiException.notFound("分享链接不存在");
        }
        Canvas canvas = canvasMapper.selectById(share.getCanvasId());
        if (canvas == null || "private".equals(share.getVisibility())) {
            throw ApiException.forbidden("该画布未公开");
        }
        return buildDetail(canvas);
    }

    public Canvas requireOwned(Long canvasId) {
        Canvas canvas = canvasMapper.selectById(canvasId);
        Long userId = RequestContext.userIdLong();
        if (canvas == null) {
            throw ApiException.notFound("画布不存在");
        }
        if (userId == null || !canvas.getOwnerId().equals(userId)) {
            throw ApiException.forbidden("无权访问该画布");
        }
        return canvas;
    }

    private Canvas requireOwnedForUpdate(Long canvasId) {
        Canvas canvas = canvasMapper.selectByIdForUpdate(canvasId);
        Long userId = RequestContext.userIdLong();
        if (canvas == null) {
            throw ApiException.notFound("画布不存在");
        }
        if (userId == null || !canvas.getOwnerId().equals(userId)) {
            throw ApiException.forbidden("无权访问该画布");
        }
        return canvas;
    }

    /** 节点/连线增量命令的原子乐观锁；expectedVersion 为空仅兼容非 Agent 内部调用。 */
    @Transactional
    public void assertAndAdvanceVersion(Long canvasId, Integer expectedVersion) {
        Canvas canvas = requireOwned(canvasId);
        if (expectedVersion != null && !expectedVersion.equals(canvas.getVersion())) {
            throw ApiException.conflict(ErrorCode.VERSION_CONFLICT, "画布已在其他会话更新，请刷新");
        }
        int updated = canvasMapper.update(null, new LambdaUpdateWrapper<Canvas>()
                .eq(Canvas::getId, canvasId)
                .eq(Canvas::getVersion, canvas.getVersion())
                .setSql("version = version + 1")
                .setSql("updated_at = now()"));
        if (updated == 0) throw ApiException.conflict(ErrorCode.VERSION_CONFLICT, "画布已在其他会话更新，请刷新");
    }

    public Canvas getById(Long canvasId) {
        return canvasMapper.selectById(canvasId);
    }

    private CanvasGraphCommand claimGraphCommand(Long canvasId, String idempotencyKey, String operation) {
        if (idempotencyKey == null || idempotencyKey.isBlank() || idempotencyKey.length() > 128) {
            throw ApiException.badRequest(ErrorCode.INVALID_INPUT, "Idempotency-Key 必须为 1-128 个字符");
        }
        return graphCommandMapper.claim(Map.of(
                "id", idGenerator.nextId(),
                "canvasId", canvasId,
                "idempotencyKey", idempotencyKey,
                "operation", operation));
    }

    public CanvasDtos.CanvasDetail buildDetail(Canvas canvas) {
        List<CanvasNode> nodes = nodeMapper.selectList(new LambdaQueryWrapper<CanvasNode>()
                .eq(CanvasNode::getCanvasId, canvas.getId()));
        List<CanvasEdge> edges = edgeMapper.selectList(new LambdaQueryWrapper<CanvasEdge>()
                .eq(CanvasEdge::getCanvasId, canvas.getId()));
        List<CanvasGroup> groups = groupMapper.selectList(new LambdaQueryWrapper<CanvasGroup>()
                .eq(CanvasGroup::getCanvasId, canvas.getId()));
        List<CanvasStack> stacks = stackMapper.selectList(new LambdaQueryWrapper<CanvasStack>()
                .eq(CanvasStack::getCanvasId, canvas.getId()));
        return new CanvasDtos.CanvasDetail(toView(canvas),
                nodes.stream().map(this::toNodePayload).toList(),
                edges.stream().map(this::toEdgePayload).toList(),
                groups.stream().map(this::toGroupPayload).toList(),
                stacks.stream().map(this::toStackPayload).toList());
    }

    public CanvasDtos.NodePayload toNodePayload(CanvasNode n) {
        Map<String, Object> params;
        Map<String, Object> outputMap = null;
        try {
            params = n.getParams() == null ? new HashMap<>() : objectMapper.readValue(n.getParams(), new TypeReference<>() {
            });
        } catch (Exception e) {
            params = new HashMap<>();
        }
        try {
            if (n.getOutput() != null && !n.getOutput().isBlank()) {
                outputMap = objectMapper.readValue(n.getOutput(), new TypeReference<>() {
                });
            }
        } catch (Exception ignored) {
        }
        return new CanvasDtos.NodePayload(n.getId(), n.getNodeType(), n.getPositionX(), n.getPositionY(),
                n.getWidth(), n.getHeight(), params, n.getStatus(), n.getCurrentOutputId(),
                n.getGroupId(), n.getStackId(), n.getCreativeType(),
                Boolean.TRUE.equals(n.getStale()), n.getModelRef(), n.getPrompt(), outputMap,
                n.getExecStatus() == null ? "idle" : n.getExecStatus());
    }

    public CanvasDtos.EdgePayload toEdgePayload(CanvasEdge e) {
        return new CanvasDtos.EdgePayload(e.getId(), e.getSourceNodeId(), e.getSourcePort(),
                e.getTargetNodeId(), e.getTargetPort(), e.getValid(),
                e.getDependencyType() == null ? "reference" : e.getDependencyType());
    }

    /**
     * Agent 上下文摘要：节点统计 / 关键词 / 连线有效性 / 选中与上下游 / stale。
     */
    public Map<String, Object> buildSummary(Long canvasId, List<Long> selectedNodeIds, int relatedDepth) {
        Canvas canvas = canvasMapper.selectById(canvasId);
        if (canvas == null) {
            throw ApiException.notFound("画布不存在");
        }
        List<CanvasNode> nodes = nodeMapper.selectList(new LambdaQueryWrapper<CanvasNode>()
                .eq(CanvasNode::getCanvasId, canvasId));
        List<CanvasEdge> edges = edgeMapper.selectList(new LambdaQueryWrapper<CanvasEdge>()
                .eq(CanvasEdge::getCanvasId, canvasId));

        Map<String, Long> typeCounts = nodes.stream()
                .collect(Collectors.groupingBy(CanvasNode::getNodeType, Collectors.counting()));
        Map<String, Long> creativeCounts = nodes.stream()
                .filter(n -> n.getCreativeType() != null && !n.getCreativeType().isBlank())
                .collect(Collectors.groupingBy(CanvasNode::getCreativeType, Collectors.counting()));

        List<String> keywords = new ArrayList<>();
        for (CanvasNode n : nodes) {
            try {
                Map<String, Object> p = n.getParams() == null ? Map.of()
                        : objectMapper.readValue(n.getParams(), new TypeReference<>() {
                });
                Object prompt = p.get("prompt");
                if (prompt != null) {
                    String text = prompt.toString().trim();
                    if (!text.isEmpty()) {
                        keywords.add(text.length() > 24 ? text.substring(0, 24) : text);
                    }
                }
            } catch (Exception ignored) {
            }
            if (keywords.size() >= 8) {
                break;
            }
        }

        long validEdges = edges.stream().filter(e -> Boolean.TRUE.equals(e.getValid())).count();
        List<Map<String, Object>> staleNodes = nodes.stream()
                .filter(n -> Boolean.TRUE.equals(n.getStale()))
                .map(n -> {
                    Map<String, Object> m = new HashMap<>();
                    m.put("nodeId", n.getId());
                    m.put("type", n.getNodeType());
                    m.put("creativeType", n.getCreativeType());
                    m.put("reason", "上游 input 依赖已变更");
                    return m;
                }).toList();

        Set<Long> selected = selectedNodeIds == null ? Set.of() : new HashSet<>(selectedNodeIds);
        Set<Long> relatedIds = new HashSet<>(selected);
        if (relatedDepth > 0 && !selected.isEmpty()) {
            Map<Long, List<CanvasEdge>> out = edges.stream().collect(Collectors.groupingBy(CanvasEdge::getSourceNodeId));
            Map<Long, List<CanvasEdge>> in = edges.stream().collect(Collectors.groupingBy(CanvasEdge::getTargetNodeId));
            Set<Long> frontier = new HashSet<>(selected);
            for (int d = 0; d < relatedDepth; d++) {
                Set<Long> next = new HashSet<>();
                for (Long id : frontier) {
                    for (CanvasEdge e : out.getOrDefault(id, List.of())) {
                        next.add(e.getTargetNodeId());
                    }
                    for (CanvasEdge e : in.getOrDefault(id, List.of())) {
                        next.add(e.getSourceNodeId());
                    }
                }
                relatedIds.addAll(next);
                frontier = next;
            }
        }

        List<Map<String, Object>> nodeBriefs = nodes.stream().map(n -> {
            Map<String, Object> m = new HashMap<>();
            m.put("id", n.getId());
            m.put("type", n.getNodeType());
            m.put("status", n.getStatus());
            m.put("creativeType", n.getCreativeType());
            m.put("stale", Boolean.TRUE.equals(n.getStale()));
            m.put("modelRef", n.getModelRef());
            m.put("execStatus", n.getExecStatus() == null ? "idle" : n.getExecStatus());
            boolean hasOutput = false;
            try {
                if (n.getOutput() != null && !n.getOutput().isBlank()) {
                    Map<String, Object> out = objectMapper.readValue(n.getOutput(), new TypeReference<>() {
                    });
                    Object outUrl = out.get("url");
                    Object outText = out.get("text");
                    if (outText == null) outText = out.get("content");
                    if (outUrl != null && !outUrl.toString().isBlank()) {
                        m.put("outputUrl", outUrl.toString());
                        hasOutput = true;
                    }
                    if (outText != null && !outText.toString().isBlank()) {
                        String t = outText.toString().trim();
                        m.put("lastOutputText", t.length() > 240 ? t.substring(0, 240) : t);
                        hasOutput = true;
                    }
                }
            } catch (Exception ignored) {
            }
            if (n.getPrompt() != null) {
                String p = n.getPrompt().trim();
                m.put("prompt", p.length() > 48 ? p.substring(0, 48) : p);
            }
            try {
                Map<String, Object> p = n.getParams() == null ? Map.of()
                        : objectMapper.readValue(n.getParams(), new TypeReference<>() {
                });
                Object title = p.get("title");
                if (title != null && !title.toString().isBlank()) {
                    m.put("title", title.toString());
                }
                Object body = p.get("lastOutputText");
                if (body == null) body = p.get("content");
                if (body == null) body = p.get("text");
                if (body != null) {
                    String t = body.toString().trim();
                    if (!t.isEmpty()) {
                        m.put("lastOutputText", t.length() > 240 ? t.substring(0, 240) : t);
                        hasOutput = true;
                    }
                }
                Object url = p.get("lastOutputUrl");
                if (url == null) url = p.get("url");
                if (url == null) url = p.get("thumbnailUrl");
                if (url != null && !url.toString().isBlank()) {
                    m.putIfAbsent("outputUrl", url.toString());
                    hasOutput = true;
                }
            } catch (Exception ignored) {
            }
            m.put("hasOutput", hasOutput);
            return m;
        }).toList();

        List<Map<String, Object>> selectedBriefs = nodes.stream()
                .filter(n -> selected.contains(n.getId()))
                .map(n -> {
                    // 选中节点给 Agent 完整可读信息（prompt / params / output / 邻居）
                    Map<String, Object> m = new HashMap<>();
                    CanvasDtos.NodePayload full = toNodePayload(n);
                    m.put("id", full.id());
                    m.put("type", full.type());
                    m.put("status", full.status());
                    m.put("creativeType", full.creativeType());
                    m.put("stale", Boolean.TRUE.equals(full.stale()));
                    m.put("modelRef", full.modelRef());
                    m.put("execStatus", full.execStatus() == null ? "idle" : full.execStatus());
                    m.put("prompt", full.prompt());
                    m.put("params", full.params() == null ? Map.of() : full.params());
                    m.put("output", full.output());
                    m.put("x", full.x());
                    m.put("y", full.y());
                    m.put("width", full.width());
                    m.put("height", full.height());
                    List<Map<String, Object>> upstream = new ArrayList<>();
                    List<Map<String, Object>> downstream = new ArrayList<>();
                    List<Map<String, Object>> inEdges = new ArrayList<>();
                    List<Map<String, Object>> outEdges = new ArrayList<>();
                    for (CanvasEdge e : edges) {
                        Map<String, Object> eb = new HashMap<>();
                        eb.put("id", e.getId());
                        eb.put("sourceNodeId", e.getSourceNodeId());
                        eb.put("targetNodeId", e.getTargetNodeId());
                        eb.put("dependencyType", e.getDependencyType() == null ? "reference" : e.getDependencyType());
                        eb.put("valid", e.getValid());
                        if (e.getTargetNodeId().equals(n.getId())) {
                            inEdges.add(eb);
                            CanvasNode src = nodes.stream().filter(x -> x.getId().equals(e.getSourceNodeId())).findFirst().orElse(null);
                            if (src != null) {
                                Map<String, Object> nb = new HashMap<>();
                                nb.put("id", src.getId());
                                nb.put("type", src.getNodeType());
                                nb.put("creativeType", src.getCreativeType());
                                nb.put("status", src.getStatus());
                                nb.put("dependencyType", eb.get("dependencyType"));
                                upstream.add(nb);
                            }
                        }
                        if (e.getSourceNodeId().equals(n.getId())) {
                            outEdges.add(eb);
                            CanvasNode tgt = nodes.stream().filter(x -> x.getId().equals(e.getTargetNodeId())).findFirst().orElse(null);
                            if (tgt != null) {
                                Map<String, Object> nb = new HashMap<>();
                                nb.put("id", tgt.getId());
                                nb.put("type", tgt.getNodeType());
                                nb.put("creativeType", tgt.getCreativeType());
                                nb.put("status", tgt.getStatus());
                                nb.put("dependencyType", eb.get("dependencyType"));
                                downstream.add(nb);
                            }
                        }
                    }
                    m.put("upstream", upstream);
                    m.put("downstream", downstream);
                    m.put("incomingEdges", inEdges);
                    m.put("outgoingEdges", outEdges);
                    boolean hasOutput = full.output() != null && !full.output().isEmpty();
                    m.put("hasOutput", hasOutput);
                    return m;
                }).toList();
        List<Map<String, Object>> relatedBriefs = nodeBriefs.stream()
                .filter(m -> relatedIds.contains(((Number) m.get("id")).longValue()))
                .toList();

        String pipelineHint = "text_base";
        if (creativeCounts.containsKey("composite") || typeCounts.containsKey("compose")) {
            pipelineHint = "post_production";
        } else if (creativeCounts.containsKey("clip") || typeCounts.containsKey("video")) {
            pipelineHint = "dynamic_gen";
        } else if (creativeCounts.containsKey("keyframe") || typeCounts.containsKey("image")) {
            pipelineHint = "visual_anchor";
        } else if (creativeCounts.containsKey("shot")) {
            pipelineHint = "storyboard";
        }

        Map<String, Object> summary = new HashMap<>();
        summary.put("canvasId", canvasId);
        summary.put("name", canvas.getName());
        summary.put("version", canvas.getVersion());
        summary.put("nodeCount", nodes.size());
        summary.put("edgeCount", edges.size());
        summary.put("nodeTypeCounts", typeCounts);
        summary.put("creativeTypeCounts", creativeCounts);
        summary.put("keywords", keywords);
        summary.put("validEdgeCount", validEdges);
        summary.put("invalidEdgeCount", edges.size() - validEdges);
        summary.put("staleNodes", staleNodes);
        summary.put("selectedNodes", selectedBriefs);
        summary.put("relatedNodes", relatedBriefs);
        summary.put("nodes", nodeBriefs);
        summary.put("edges", edges.stream().map(e -> {
            Map<String, Object> m = new HashMap<>();
            m.put("id", e.getId());
            m.put("source", e.getSourceNodeId());
            m.put("target", e.getTargetNodeId());
            m.put("valid", e.getValid());
            m.put("dependencyType", e.getDependencyType() == null ? "reference" : e.getDependencyType());
            return m;
        }).toList());
        summary.put("pipelineHint", pipelineHint);
        if (!selected.isEmpty()) {
            summary.put("inputChains", buildInputChains(nodes, edges, selected));
        }
        return summary;
    }

    /** 选中节点的 input 依赖上游链（Agent 拓扑规划）。 */
    private Map<String, List<Map<String, Object>>> buildInputChains(List<CanvasNode> nodes,
                                                                     List<CanvasEdge> edges,
                                                                     Set<Long> selected) {
        Map<Long, CanvasNode> byId = nodes.stream().collect(Collectors.toMap(CanvasNode::getId, n -> n));
        Map<Long, List<Long>> inputByTarget = edges.stream()
                .filter(e -> "input".equals(e.getDependencyType()))
                .collect(Collectors.groupingBy(CanvasEdge::getTargetNodeId,
                        Collectors.mapping(CanvasEdge::getSourceNodeId, Collectors.toList())));
        Map<String, List<Map<String, Object>>> chains = new HashMap<>();
        for (Long targetId : selected) {
            List<Map<String, Object>> chain = new ArrayList<>();
            Set<Long> seen = new HashSet<>();
            collectInputUpstream(targetId, inputByTarget, byId, chain, seen);
            chains.put(String.valueOf(targetId), chain);
        }
        return chains;
    }

    private void collectInputUpstream(Long nodeId, Map<Long, List<Long>> inputByTarget,
                                      Map<Long, CanvasNode> byId, List<Map<String, Object>> chain, Set<Long> seen) {
        for (Long src : inputByTarget.getOrDefault(nodeId, List.of())) {
            if (!seen.add(src)) {
                continue;
            }
            collectInputUpstream(src, inputByTarget, byId, chain, seen);
            CanvasNode n = byId.get(src);
            if (n != null) {
                Map<String, Object> m = new HashMap<>();
                m.put("id", n.getId());
                m.put("type", n.getNodeType());
                m.put("creativeType", n.getCreativeType());
                m.put("execStatus", n.getExecStatus());
                chain.add(m);
            }
        }
    }

    /** 上游节点变更时，沿 input 连线将下游标 stale。 */
    public void markDownstreamStale(Long canvasId, Long sourceNodeId) {
        List<CanvasEdge> outs = edgeMapper.selectList(new LambdaQueryWrapper<CanvasEdge>()
                .eq(CanvasEdge::getCanvasId, canvasId)
                .eq(CanvasEdge::getSourceNodeId, sourceNodeId)
                .eq(CanvasEdge::getDependencyType, "input"));
        for (CanvasEdge e : outs) {
            CanvasNode target = nodeMapper.selectById(e.getTargetNodeId());
            if (target != null && !Boolean.TRUE.equals(target.getStale())) {
                target.setStale(true);
                String exec = target.getExecStatus() == null ? "" : target.getExecStatus().toLowerCase();
                // 只打 stale 标记；禁止覆盖 queued/running/已成功，否则调度会把成品当可再提交
                if (!List.of("queued", "running", "succeeded", "success", "ready").contains(exec)) {
                    target.setExecStatus("stale");
                }
                target.setUpdatedAt(OffsetDateTime.now());
                nodeMapper.updateById(target);
                markDownstreamStale(canvasId, target.getId());
            }
        }
    }

    public CanvasDtos.GroupPayload toGroupPayload(CanvasGroup g) {
        return new CanvasDtos.GroupPayload(g.getId(), g.getName(), g.getColor(), g.getLayout(), g.getNodeIds());
    }

    public CanvasDtos.StackPayload toStackPayload(CanvasStack s) {
        return new CanvasDtos.StackPayload(s.getId(), s.getCollapsed(), s.getNodeIds());
    }

    /**
     * 画布列表的封面始终反映画布内最后生成的有效图片；没有图片产出时由前端展示默认封面。
     * 历史 thumbnailUrl 不参与列表展示，避免旧封面掩盖最新的创作结果。
     */
    private List<CanvasDtos.CanvasView> toListViews(List<Canvas> canvases) {
        if (canvases.isEmpty()) {
            return List.of();
        }
        Set<Long> canvasIds = canvases.stream().map(Canvas::getId).collect(Collectors.toSet());
        Map<Long, String> thumbnails = new HashMap<>();
        List<CanvasNode> imageNodes = nodeMapper.selectList(new LambdaQueryWrapper<CanvasNode>()
                .in(CanvasNode::getCanvasId, canvasIds)
                .eq(CanvasNode::getNodeType, "image")
                .orderByDesc(CanvasNode::getUpdatedAt));
        for (CanvasNode node : imageNodes) {
            if (Boolean.TRUE.equals(node.getStale())) {
                continue;
            }
            String outputUrl = imageOutputUrl(node);
            if (!outputUrl.isBlank()) {
                thumbnails.putIfAbsent(node.getCanvasId(), outputUrl);
            }
        }
        return canvases.stream().map(canvas -> toView(canvas, thumbnails.get(canvas.getId()))).toList();
    }

    private String imageOutputUrl(CanvasNode node) {
        Map<String, Object> output = readMap(node.getOutput());
        String url = firstNonBlank(output, "url", "imageUrl", "thumbnailUrl");
        if (!url.isBlank()) {
            return url;
        }
        Map<String, Object> params = readMap(node.getParams());
        return firstNonBlank(params, "lastOutputUrl", "output_url", "url", "thumbnailUrl", "imageUrl");
    }

    private String firstNonBlank(Map<String, Object> values, String... keys) {
        for (String key : keys) {
            Object value = values.get(key);
            if (value != null && !value.toString().isBlank()) {
                return value.toString();
            }
        }
        return "";
    }

    public CanvasDtos.CanvasView toView(Canvas c) {
        return toView(c, c.getThumbnailUrl());
    }

    private CanvasDtos.CanvasView toView(Canvas c, String thumbnailUrl) {
        return new CanvasDtos.CanvasView(c.getId(), c.getOwnerId(), c.getName(), c.getDescription(),
                c.getSchemaVersion(), c.getVersion(), thumbnailUrl, c.getVisibility(), c.getShareToken(),
                c.getCreatedAt() == null ? null : c.getCreatedAt().toString(),
                c.getUpdatedAt() == null ? null : c.getUpdatedAt().toString());
    }

    private boolean isSchemaCompatible(String version) {
        try {
            String[] parts = version.split("\\.");
            int major = Integer.parseInt(parts[0]);
            return major >= 1;
        } catch (Exception e) {
            return false;
        }
    }

    /** 整表保存不得抹掉生成产物：前端 payload 常缺 output，或把 succeeded 写成 idle。 */
    private void applyPreservedGeneration(CanvasNode node, CanvasDtos.NodePayload incoming, CanvasNode previous) {
        if (previous == null) {
            return;
        }
        if ((incoming.output() == null || incoming.output().isEmpty())
                && previous.getOutput() != null && !previous.getOutput().isBlank()) {
            node.setOutput(previous.getOutput());
        }
        node.setParams(writeJson(mergeParamsKeepMedia(node.getParams(), previous.getParams())));
        String incomingExec = node.getExecStatus() == null ? "" : node.getExecStatus().toLowerCase();
        String prevExec = previous.getExecStatus() == null ? "" : previous.getExecStatus().toLowerCase();
        if (List.of("succeeded", "success", "ready").contains(prevExec)
                && List.of("idle", "stale", "").contains(incomingExec)) {
            node.setExecStatus(previous.getExecStatus());
            String st = node.getStatus() == null ? "" : node.getStatus().toLowerCase();
            if (List.of("idle", "stale", "").contains(st)) {
                node.setStatus(previous.getStatus() != null ? previous.getStatus() : previous.getExecStatus());
            }
        }
    }

    private Map<String, Object> mergeParamsKeepMedia(String incomingJson, String previousJson) {
        Map<String, Object> incoming = readMap(incomingJson);
        Map<String, Object> previous = readMap(previousJson);
        for (String key : List.of("url", "lastOutputUrl", "thumbnailUrl", "output_url", "lastOutputText")) {
            Object cur = incoming.get(key);
            if ((cur == null || cur.toString().isBlank()) && previous.get(key) != null) {
                incoming.put(key, previous.get(key));
            }
        }
        return incoming;
    }

    private Map<String, Object> readMap(String json) {
        if (json == null || json.isBlank()) {
            return new HashMap<>();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<>() {
            });
        } catch (Exception e) {
            return new HashMap<>();
        }
    }

    private String writeJson(Object obj) {
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
