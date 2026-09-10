package com.vibepaper.gateway.filter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vibepaper.common.api.ErrorResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 网关限流（滑动窗口，Redis INCR + TTL，Fail Open）。
 * 登录/注册 5/min/IP，全局 100 req/s/IP，任务提交 10/min/用户。
 */
@Slf4j
@Component
public class RateLimitGlobalFilter implements GlobalFilter, Ordered {

    private final ReactiveStringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public RateLimitGlobalFilter(ReactiveStringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String ip = clientIp(exchange);
        String path = exchange.getRequest().getURI().getPath();
        String method = exchange.getRequest().getMethod().name();
        String userId = exchange.getRequest().getHeaders().getFirst("X-User-Id");
        Instant now = Instant.now();
        String minuteBucket = now.getEpochSecond() / 60 + "";
        String key;
        long limit;
        Duration ttl;
        if (path.equals("/api/v1/auth/login") || path.equals("/api/v1/auth/register")) {
            key = "rate:login:" + ip + ":" + minuteBucket;
            limit = 5;
            ttl = Duration.ofMinutes(2);
        } else if (method.equals("POST") && path.equals("/api/v1/tasks")) {
            key = "rate:task:" + (userId == null ? ip : userId) + ":" + minuteBucket;
            limit = 10;
            ttl = Duration.ofMinutes(2);
        } else {
            // This bucket must be one second wide. The old ten-second bucket
            // silently made the documented 100 req/s limit behave as 10 req/s.
            key = "rate:global:" + ip + ":" + now.getEpochSecond();
            limit = 100;
            ttl = Duration.ofSeconds(2);
        }

        return redis.opsForValue().increment(key)
                .flatMap(count -> {
                    if (count == 1) {
                        return redis.expire(key, ttl).then(Mono.just(count));
                    }
                    return Mono.just(count);
                })
                .flatMap(count -> {
                    if (count > limit) {
                        return reject(exchange, "RATE_LIMITED", "请求过于频繁，请稍后再试", HttpStatus.TOO_MANY_REQUESTS);
                    }
                    return chain.filter(exchange);
                })
                .onErrorResume(e -> {
                    log.warn("rate limit redis error, fail open: {}", e.getMessage());
                    return chain.filter(exchange);
                });
    }

    private String clientIp(ServerWebExchange exchange) {
        String forwarded = exchange.getRequest().getHeaders().getFirst("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        InetSocketAddress remote = exchange.getRequest().getRemoteAddress();
        if (remote != null && remote.getAddress() != null) {
            return remote.getAddress().getHostAddress();
        }
        return "unknown";
    }

    private Mono<Void> reject(ServerWebExchange exchange, String code, String message, HttpStatus status) {
        ErrorResponse body = ErrorResponse.of(code, message, null,
                UUID.randomUUID().toString().replace("-", ""), true);
        try {
            byte[] bytes = objectMapper.writeValueAsBytes(body);
            exchange.getResponse().setStatusCode(status);
            exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
            DataBuffer buffer = exchange.getResponse().bufferFactory().wrap(bytes);
            return exchange.getResponse().writeWith(Mono.just(buffer));
        } catch (Exception e) {
            exchange.getResponse().setStatusCode(HttpStatus.INTERNAL_SERVER_ERROR);
            return exchange.getResponse().setComplete();
        }
    }

    @Override
    public int getOrder() {
        return -50;
    }
}
